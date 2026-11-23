import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';

const ZIP_LOCAL_FILE_HEADER_SIG = 0x04034b50;
const ZIP_CENTRAL_DIR_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

const EXTRA_FIELD_EXTENDED_TIMESTAMP = 0x5455;
const EXTRA_FIELD_INFOZIP_NEW_UNIX = 0x7875;

const MACHO_64_LE_MAGIC = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;

function assertValidEntryPath(entryName) {
  const normalized = entryName.replace(/\\/g, '/');
  const trimmed = normalized.replace(/\/+$/, '');
  if (!trimmed) {
    return;
  }
  const segments = trimmed.split('/');
  if (segments.includes('__MACOSX')) {
    throw new Error(`IPA contains forbidden __MACOSX directory entry: "${entryName}"`);
  }
  const base = segments[segments.length - 1];
  if (base === '.DS_Store' || segments.includes('.DS_Store')) {
    throw new Error(`IPA contains forbidden .DS_Store entry: "${entryName}"`);
  }
  if (base.startsWith('._')) {
    throw new Error(`IPA contains forbidden AppleDouble entry: "${entryName}"`);
  }
}

function assertNoForbiddenExtraFields(extraBuf, entryName, headerKind) {
  let offset = 0;
  while (offset + 4 <= extraBuf.length) {
    const headerId = extraBuf.readUInt16LE(offset);
    const dataSize = extraBuf.readUInt16LE(offset + 2);
    if (
      headerId === EXTRA_FIELD_EXTENDED_TIMESTAMP ||
      headerId === EXTRA_FIELD_INFOZIP_NEW_UNIX
    ) {
      const hexId = `0x${headerId.toString(16)}`;
      throw new Error(
        `IPA contains forbidden macOS Unix extra field ${hexId} in ${headerKind} for "${entryName}". Repackage using "zip -qrX".`
      );
    }
    if (offset + 4 + dataSize > extraBuf.length) {
      throw new Error(
        `Malformed ZIP extra field in ${headerKind} for "${entryName}"`
      );
    }
    offset += 4 + dataSize;
  }
}

function findEocdOffset(buf) {
  if (buf.length < 22) {
    throw new Error('Invalid IPA: buffer is smaller than minimum ZIP size (22 bytes)');
  }
  const minOffset = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) {
      const commentLength = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLength === buf.length) {
        return i;
      }
    }
  }
  throw new Error('Invalid IPA: End of Central Directory (PK\\x05\\x06) not found');
}

function scanZipHeaders(buf) {
  const eocdOffset = findEocdOffset(buf);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (cdOffset + cdSize > eocdOffset) {
    throw new Error('Invalid IPA: ZIP Central Directory extends beyond EOCD');
  }

  let cdPos = cdOffset;
  let scanned = 0;
  while (cdPos < cdOffset + cdSize) {
    if (cdPos + 46 > cdOffset + cdSize || buf.readUInt32LE(cdPos) !== ZIP_CENTRAL_DIR_SIG) {
      throw new Error(`Invalid IPA: corrupt Central Directory header at offset ${cdPos}`);
    }
    const cdNameLen = buf.readUInt16LE(cdPos + 28);
    const cdExtraLen = buf.readUInt16LE(cdPos + 30);
    const cdCommentLen = buf.readUInt16LE(cdPos + 32);
    const localHeaderOffset = buf.readUInt32LE(cdPos + 42);

    const cdHeaderEnd = cdPos + 46 + cdNameLen + cdExtraLen + cdCommentLen;
    if (cdHeaderEnd > cdOffset + cdSize) {
      throw new Error(`Invalid IPA: truncated Central Directory entry at offset ${cdPos}`);
    }

    const cdName = buf.subarray(cdPos + 46, cdPos + 46 + cdNameLen).toString('utf8');
    const cdExtra = buf.subarray(cdPos + 46 + cdNameLen, cdPos + 46 + cdNameLen + cdExtraLen);
    assertValidEntryPath(cdName);
    assertNoForbiddenExtraFields(cdExtra, cdName, 'Central Directory');

    if (localHeaderOffset + 30 > cdOffset) {
      throw new Error(`Invalid IPA: Local File Header out of range for "${cdName}"`);
    }
    if (buf.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER_SIG) {
      throw new Error(`Invalid IPA: missing PK\\x03\\x04 Local File Header for "${cdName}"`);
    }

    const lfhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const lfhDataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
    if (lfhDataStart > cdOffset) {
      throw new Error(`Invalid IPA: truncated Local File Header for "${cdName}"`);
    }

    const lfhName = buf
      .subarray(localHeaderOffset + 30, localHeaderOffset + 30 + lfhNameLen)
      .toString('utf8');
    const lfhExtra = buf.subarray(
      localHeaderOffset + 30 + lfhNameLen,
      localHeaderOffset + 30 + lfhNameLen + lfhExtraLen
    );
    assertValidEntryPath(lfhName);
    assertNoForbiddenExtraFields(lfhExtra, lfhName, 'Local File Header');

    cdPos = cdHeaderEnd;
    scanned += 1;
  }

  if (scanned !== totalEntries) {
    throw new Error(
      `Invalid IPA: Central Directory entry count mismatch (expected ${totalEntries}, found ${scanned})`
    );
  }
}

function readUIntBE(buf, offset, byteCount) {
  let value = 0n;
  for (let i = 0; i < byteCount; i += 1) {
    value = (value << 8n) | BigInt(buf[offset + i]);
  }
  return Number(value);
}

function parseBinaryPlist(buf) {
  if (buf.length < 40 || buf.subarray(0, 8).toString('ascii') !== 'bplist00') {
    throw new Error('Invalid Info.plist: unsupported binary plist header (expected bplist00)');
  }

  const trailerOffset = buf.length - 32;
  const offsetIntSize = buf[trailerOffset + 6];
  const objectRefSize = buf[trailerOffset + 7];
  const numObjects = Number(buf.readBigUInt64BE(trailerOffset + 8));
  const topObject = Number(buf.readBigUInt64BE(trailerOffset + 16));
  const offsetTableOffset = Number(buf.readBigUInt64BE(trailerOffset + 24));

  if (![1, 2, 4, 8].includes(offsetIntSize) || ![1, 2, 4, 8].includes(objectRefSize)) {
    throw new Error('Invalid bplist00 trailer: unsupported integer/reference size');
  }
  if (numObjects <= 0 || topObject < 0 || topObject >= numObjects) {
    throw new Error('Invalid bplist00 trailer: invalid object count or topObject index');
  }
  if (
    offsetTableOffset < 8 ||
    offsetTableOffset + numObjects * offsetIntSize > trailerOffset
  ) {
    throw new Error('Invalid bplist00 trailer: offset table out of bounds');
  }

  const offsets = new Array(numObjects);
  for (let i = 0; i < numObjects; i += 1) {
    const off = readUIntBE(buf, offsetTableOffset + i * offsetIntSize, offsetIntSize);
    if (off < 8 || off >= offsetTableOffset) {
      throw new Error(`Invalid bplist00 object offset at index ${i}`);
    }
    offsets[i] = off;
  }

  function readLength(pos, info) {
    if (info !== 0x0f) {
      return { length: info, nextPos: pos };
    }
    if (pos >= offsetTableOffset) {
      throw new Error('Invalid bplist00 extended length: out of bounds');
    }
    const lenMarker = buf[pos];
    if ((lenMarker >> 4) !== 0x01) {
      throw new Error(`Invalid bplist00 extended length marker: 0x${lenMarker.toString(16)}`);
    }
    const byteCount = 1 << (lenMarker & 0x0f);
    if (pos + 1 + byteCount > offsetTableOffset) {
      throw new Error('Invalid bplist00 extended length integer: out of bounds');
    }
    return {
      length: readUIntBE(buf, pos + 1, byteCount),
      nextPos: pos + 1 + byteCount,
    };
  }

  const cache = new Map();
  const visiting = new Set();

  function parseObject(index) {
    if (index < 0 || index >= numObjects) {
      throw new Error(`Invalid bplist00 object reference: ${index}`);
    }
    if (cache.has(index)) {
      return cache.get(index);
    }
    if (visiting.has(index)) {
      throw new Error(`Cyclic object reference in bplist00 at index ${index}`);
    }
    visiting.add(index);

    try {
      const offset = offsets[index];
      const marker = buf[offset];
      const objType = marker >> 4;
      const objInfo = marker & 0x0f;
      let result;

      switch (objType) {
        case 0x0:
          if (objInfo === 0x08) result = false;
          else if (objInfo === 0x09) result = true;
          else result = null;
          break;
        case 0x1: {
          const byteCount = 1 << objInfo;
          if (offset + 1 + byteCount > offsetTableOffset) {
            throw new Error('Invalid bplist00 integer: out of bounds');
          }
          result =
            byteCount === 8
              ? Number(buf.readBigInt64BE(offset + 1))
              : readUIntBE(buf, offset + 1, byteCount);
          break;
        }
        case 0x2: {
          const byteCount = 1 << objInfo;
          if (offset + 1 + byteCount > offsetTableOffset) {
            throw new Error('Invalid bplist00 real: out of bounds');
          }
          if (byteCount === 4) result = buf.readFloatBE(offset + 1);
          else if (byteCount === 8) result = buf.readDoubleBE(offset + 1);
          else throw new Error(`Unsupported bplist00 real size: ${byteCount}`);
          break;
        }
        case 0x3:
          if (offset + 9 > offsetTableOffset) {
            throw new Error('Invalid bplist00 date: out of bounds');
          }
          result = new Date((buf.readDoubleBE(offset + 1) + 978307200) * 1000);
          break;
        case 0x4: {
          const { length, nextPos } = readLength(offset + 1, objInfo);
          if (nextPos + length > offsetTableOffset) {
            throw new Error('Invalid bplist00 data: out of bounds');
          }
          result = Buffer.from(buf.subarray(nextPos, nextPos + length));
          break;
        }
        case 0x5: {
          const { length, nextPos } = readLength(offset + 1, objInfo);
          if (nextPos + length > offsetTableOffset) {
            throw new Error('Invalid bplist00 ASCII string: out of bounds');
          }
          result = buf.subarray(nextPos, nextPos + length).toString('latin1');
          break;
        }
        case 0x6: {
          const { length, nextPos } = readLength(offset + 1, objInfo);
          const byteLen = length * 2;
          if (nextPos + byteLen > offsetTableOffset) {
            throw new Error('Invalid bplist00 UTF-16 string: out of bounds');
          }
          const copy = Buffer.from(buf.subarray(nextPos, nextPos + byteLen));
          copy.swap16();
          result = copy.toString('utf16le');
          break;
        }
        case 0x8: {
          const byteCount = objInfo + 1;
          if (offset + 1 + byteCount > offsetTableOffset) {
            throw new Error('Invalid bplist00 UID: out of bounds');
          }
          result = readUIntBE(buf, offset + 1, byteCount);
          break;
        }
        case 0xa:
        case 0xc: {
          const { length, nextPos } = readLength(offset + 1, objInfo);
          if (nextPos + length * objectRefSize > offsetTableOffset) {
            throw new Error('Invalid bplist00 array: out of bounds');
          }
          result = new Array(length);
          for (let i = 0; i < length; i += 1) {
            const ref = readUIntBE(buf, nextPos + i * objectRefSize, objectRefSize);
            result[i] = parseObject(ref);
          }
          break;
        }
        case 0xd: {
          const { length, nextPos } = readLength(offset + 1, objInfo);
          const valBase = nextPos + length * objectRefSize;
          if (valBase + length * objectRefSize > offsetTableOffset) {
            throw new Error('Invalid bplist00 dictionary: out of bounds');
          }
          result = {};
          for (let i = 0; i < length; i += 1) {
            const keyRef = readUIntBE(buf, nextPos + i * objectRefSize, objectRefSize);
            const valRef = readUIntBE(buf, valBase + i * objectRefSize, objectRefSize);
            const key = parseObject(keyRef);
            result[String(key)] = parseObject(valRef);
          }
          break;
        }
        default:
          throw new Error(`Unsupported bplist00 object type: 0x${objType.toString(16)}`);
      }

      cache.set(index, result);
      return result;
    } finally {
      visiting.delete(index);
    }
  }

  return parseObject(topObject);
}

function decodeXmlEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_m, entity) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
          return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
        }
        if (entity.startsWith('#')) {
          return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
        }
        return `&${entity};`;
    }
  });
}

function parseXmlPlist(xmlText) {
  const cleaned = xmlText
    .replace(/^\uFEFF/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '');

  const stack = [{ type: 'root', value: [], pendingKey: null }];
  let openLeaf = null;
  const tagRegex = /<(\/?)([A-Za-z0-9:_-]+)(?:\s[^<>]*?)?\s*\/?>/g;

  const attachValue = (val) => {
    const top = stack[stack.length - 1];
    if (top.type === 'dict') {
      if (top.pendingKey === null) {
        throw new Error('Invalid XML plist: value inside <dict> without preceding <key>');
      }
      top.value[top.pendingKey] = val;
      top.pendingKey = null;
    } else {
      top.value.push(val);
    }
  };

  for (const match of cleaned.matchAll(tagRegex)) {
    const isClosing = match[1] === '/';
    const tag = match[2];
    const isSelfClosing = !isClosing && match[0].trimEnd().endsWith('/>');
    const tagStart = match.index;
    const tagEnd = tagStart + match[0].length;

    if (tag === 'plist') {
      continue;
    }

    if (openLeaf) {
      if (!isClosing || tag !== openLeaf.tag) {
        throw new Error(`Invalid XML plist: expected </${openLeaf.tag}>, got <${isClosing ? '/' : ''}${tag}>`);
      }
      const rawText = cleaned.slice(openLeaf.start, tagStart);
      openLeaf = null;

      if (tag === 'key') {
        const top = stack[stack.length - 1];
        if (top.type !== 'dict') {
          throw new Error('Invalid XML plist: <key> outside <dict>');
        }
        top.pendingKey = decodeXmlEntities(rawText);
      } else if (tag === 'string' || tag === 'date') {
        attachValue(decodeXmlEntities(rawText));
      } else if (tag === 'integer') {
        const parsed = Number.parseInt(rawText.trim(), 10);
        if (Number.isNaN(parsed)) {
          throw new Error(`Invalid XML plist <integer>: "${rawText}"`);
        }
        attachValue(parsed);
      } else if (tag === 'real') {
        const parsed = Number.parseFloat(rawText.trim());
        if (Number.isNaN(parsed)) {
          throw new Error(`Invalid XML plist <real>: "${rawText}"`);
        }
        attachValue(parsed);
      } else if (tag === 'data') {
        attachValue(Buffer.from(rawText.replace(/\s+/g, ''), 'base64'));
      } else if (tag === 'true') {
        attachValue(true);
      } else if (tag === 'false') {
        attachValue(false);
      } else {
        throw new Error(`Unsupported XML plist leaf tag: <${tag}>`);
      }
      continue;
    }

    if (isClosing) {
      const popped = stack.pop();
      if (!popped || popped.type !== tag) {
        throw new Error(`Invalid XML plist: unexpected closing tag </${tag}>`);
      }
      if (popped.type === 'dict' && popped.pendingKey !== null) {
        throw new Error(`Invalid XML plist: dangling <key>${popped.pendingKey}</key> without value`);
      }
      continue;
    }

    if (tag === 'dict') {
      const obj = {};
      attachValue(obj);
      if (!isSelfClosing) {
        stack.push({ type: 'dict', value: obj, pendingKey: null });
      }
    } else if (tag === 'array') {
      const arr = [];
      attachValue(arr);
      if (!isSelfClosing) {
        stack.push({ type: 'array', value: arr, pendingKey: null });
      }
    } else if (tag === 'true') {
      if (isSelfClosing) attachValue(true);
      else openLeaf = { tag, start: tagEnd };
    } else if (tag === 'false') {
      if (isSelfClosing) attachValue(false);
      else openLeaf = { tag, start: tagEnd };
    } else if (tag === 'string' || tag === 'date') {
      if (isSelfClosing) attachValue('');
      else openLeaf = { tag, start: tagEnd };
    } else if (tag === 'key' || tag === 'integer' || tag === 'real' || tag === 'data') {
      if (isSelfClosing) {
        throw new Error(`Invalid XML plist: self-closing <${tag}/> is not allowed`);
      }
      openLeaf = { tag, start: tagEnd };
    } else {
      throw new Error(`Unsupported XML plist tag: <${tag}>`);
    }
  }

  if (openLeaf) {
    throw new Error(`Invalid XML plist: unclosed <${openLeaf.tag}>`);
  }
  if (stack.length !== 1) {
    throw new Error(`Invalid XML plist: unclosed <${stack[stack.length - 1].type}>`);
  }
  if (stack[0].value.length !== 1) {
    throw new Error(`Invalid XML plist: expected 1 root object, found ${stack[0].value.length}`);
  }
  return stack[0].value[0];
}

function parseInfoPlist(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new Error('Info.plist is empty');
  }
  if (buf.subarray(0, 8).toString('ascii') === 'bplist00') {
    return parseBinaryPlist(buf);
  }
  const text = buf.toString('utf8');
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<plist') || trimmed.startsWith('<!DOCTYPE')) {
    return parseXmlPlist(text);
  }
  throw new Error('Unsupported Info.plist format (expected XML plist or bplist00)');
}

function assertNonEmptyString(obj, key) {
  const val = obj?.[key];
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new Error(`Info.plist missing required non-empty string key "${key}"`);
  }
  return val;
}

function validateInfoPlistKeys(plist) {
  if (!plist || typeof plist !== 'object' || Array.isArray(plist)) {
    throw new Error('Info.plist root must be a dictionary');
  }
  const executable = assertNonEmptyString(plist, 'CFBundleExecutable');
  const bundleId = assertNonEmptyString(plist, 'CFBundleIdentifier');
  const displayName = assertNonEmptyString(plist, 'CFBundleDisplayName');

  if (!Array.isArray(plist.UIBackgroundModes) || !plist.UIBackgroundModes.includes('audio')) {
    throw new Error('Info.plist UIBackgroundModes must contain "audio"');
  }

  const ats = plist.NSAppTransportSecurity;
  if (!ats || typeof ats !== 'object' || ats.NSAllowsArbitraryLoads !== true) {
    throw new Error('Info.plist NSAppTransportSecurity.NSAllowsArbitraryLoads must be true');
  }

  const orientations = plist.UISupportedInterfaceOrientations;
  if (!Array.isArray(orientations) || orientations.length === 0) {
    throw new Error('Info.plist UISupportedInterfaceOrientations must be a non-empty array');
  }

  return { executable, bundleId, displayName };
}

export function verifyIpaBuffer(input) {
  const buf = Buffer.isBuffer(input)
    ? input
    : input instanceof Uint8Array
      ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
      : null;

  if (!buf) {
    throw new TypeError('verifyIpaBuffer requires a Buffer or Uint8Array');
  }

  scanZipHeaders(buf);

  const zip = new AdmZip(buf);
  const zipEntries = zip.getEntries();
  const entries = zipEntries.map((e) => e.entryName);

  for (const entryName of entries) {
    assertValidEntryPath(entryName);
  }

  const topAppDirs = new Set();
  for (const entryName of entries) {
    const dirMatch = entryName.match(/^Payload\/([^/]+\.app)(?:\/|$)/);
    if (dirMatch) {
      topAppDirs.add(dirMatch[1]);
    }
  }
  if (topAppDirs.size !== 1) {
    throw new Error(
      `Expected exactly 1 shallow Payload/<App>.app bundle, found ${topAppDirs.size}`
    );
  }

  const plistMatches = zipEntries.filter(
    (entry) => !entry.isDirectory && /^Payload\/([^/]+\.app)\/Info\.plist$/.test(entry.entryName)
  );
  if (plistMatches.length !== 1) {
    throw new Error(
      `Expected exactly 1 shallow Payload/<App>.app/Info.plist, found ${plistMatches.length}`
    );
  }

  const plistEntry = plistMatches[0];
  const appName = plistEntry.entryName.match(/^Payload\/([^/]+\.app)\/Info\.plist$/)[1];
  const plist = parseInfoPlist(plistEntry.getData());
  const { executable, bundleId, displayName } = validateInfoPlistKeys(plist);

  if (executable.includes('/') || executable.includes('\\') || executable === '..' || executable === '.') {
    throw new Error(`Invalid CFBundleExecutable value: "${executable}"`);
  }

  const execPath = `Payload/${appName}/${executable}`;
  const execEntry = zipEntries.find((entry) => !entry.isDirectory && entry.entryName === execPath);
  if (!execEntry) {
    throw new Error(`Missing executable binary inside IPA: "${execPath}"`);
  }

  const execBuf = execEntry.getData();
  if (!execBuf || execBuf.length < 8) {
    throw new Error(`Executable "${execPath}" is empty or too small (${execBuf?.length ?? 0} bytes)`);
  }

  const magic = execBuf.readUInt32LE(0);
  if (magic !== MACHO_64_LE_MAGIC) {
    throw new Error(
      `Executable "${execPath}" has invalid Mach-O 64-bit magic: 0x${magic.toString(16)} (expected 0xfeedfacf)`
    );
  }

  const cpuType = execBuf.readInt32LE(4);
  if (cpuType !== CPU_TYPE_ARM64) {
    throw new Error(
      `Executable "${execPath}" is not ARM64 Mach-O: cpuType=0x${(cpuType >>> 0).toString(16)} (expected 0x0100000c)`
    );
  }

  if (execBuf.includes('localhost:1420')) {
    throw new Error(`Executable "${execPath}" contains development server residue "localhost:1420"`);
  }

  return {
    appName,
    bundleId,
    displayName,
    executable,
    entries,
  };
}

export function verifyIpaFile(ipaPath) {
  if (typeof ipaPath !== 'string' || ipaPath.trim().length === 0) {
    throw new TypeError('verifyIpaFile requires a non-empty file path');
  }
  const resolved = path.resolve(ipaPath);
  const buf = fs.readFileSync(resolved);
  return verifyIpaBuffer(buf);
}

const isCli = (() => {
  if (!process.argv[1]) return false;
  try {
    const entryReal = fs.realpathSync(path.resolve(process.argv[1]));
    const selfReal = fs.realpathSync(new URL(import.meta.url));
    return pathToFileURL(entryReal).href === pathToFileURL(selfReal).href;
  } catch {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  }
})();

if (isCli) {
  const target = process.argv[2];
  if (!target || target === '-h' || target === '--help') {
    console.error('Usage: node scripts/verify-ios-ipa.mjs <path-to-ipa>');
    process.exit(target ? 0 : 1);
  }
  try {
    const summary = verifyIpaFile(target);
    console.log(
      `IPA verified: app=${summary.appName}, bundleId=${summary.bundleId}, displayName=${summary.displayName}, executable=${summary.executable}, entries=${summary.entries.length}`
    );
  } catch (err) {
    console.error(`IPA verification failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
