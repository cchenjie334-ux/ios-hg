import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import AdmZip from 'adm-zip';
import { build } from 'esbuild';

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
function setMockNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', {
    value,
    configurable: true,
    writable: true,
  });
}
function restoreNavigator() {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
  } else {
    delete globalThis.navigator;
  }
}

const bundle = await build({
  entryPoints: [
    'src/orientation.ts',
    'src/plugins/iosPlayback.ts',
    'src/plugins/mediaCapabilities.ts',
  ],
  outdir: 'unused',
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  define: {
    __APP_VERSION__: '"0.0.4-test"',
  },
  plugins: [
    {
      name: 'ios-compat-fixture',
      setup(b) {
        b.onResolve({ filter: /^(hls\.js|@tauri-apps\/api\/core)$/ }, (args) => ({
          path: args.path,
          namespace: 'fixture',
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
          if (path === 'hls.js') {
            return {
              contents: `export default {
                isSupported: () => globalThis.iosCompatFixture.hls,
                getMediaSource: () => globalThis.iosCompatFixture.mse,
              };`,
            };
          }
          return {
            contents: `export const invoke = (...args) => globalThis.iosCompatFixture.invoke(...args);
              export const isTauri = () => globalThis.iosCompatFixture.isTauri();`,
          };
        });
      },
    },
  ],
});

const load = (name) => {
  const file = bundle.outputFiles.find((f) => f.path.endsWith(name));
  assert.ok(file, `Expected bundled output for ${name}`);
  return import(`data:text/javascript;base64,${Buffer.from(file.text).toString('base64')}`);
};

try {
  // 1. orientation.ts on simulated iPhone Tauri container
  setMockNavigator({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15',
    maxTouchPoints: 5,
  });
  const invokeCalls = [];
  globalThis.iosCompatFixture = {
    isTauri: () => true,
    invoke: async (cmd, payload) => {
      invokeCalls.push([cmd, payload]);
    },
    hls: true,
    mse: { isTypeSupported: () => true },
  };
  const { setMobileOrientation } = await load('orientation.js');
  await setMobileOrientation(true);
  await setMobileOrientation(false);
  assert.deepEqual(invokeCalls, [
    ['set_orientation', { landscape: true }],
    ['set_orientation', { landscape: false }],
  ]);

  // 2 & 3. WebKit Picture-in-Picture and standard PiP helpers
  const { isVideoInPictureInPicture, toggleVideoPictureInPicture } = await load('iosPlayback.js');

  const webkitVideo = {
    webkitPresentationMode: 'inline',
    webkitSupportsPresentationMode: (mode) => mode === 'picture-in-picture',
    webkitSetPresentationMode(mode) {
      this.webkitPresentationMode = mode;
    },
  };
  assert.equal(isVideoInPictureInPicture(webkitVideo, {}), false);
  assert.equal(await toggleVideoPictureInPicture(webkitVideo, {}), 'entered');
  assert.equal(webkitVideo.webkitPresentationMode, 'picture-in-picture');
  assert.equal(isVideoInPictureInPicture(webkitVideo, {}), true);
  assert.equal(await toggleVideoPictureInPicture(webkitVideo, {}), 'exited');
  assert.equal(webkitVideo.webkitPresentationMode, 'inline');
  assert.equal(isVideoInPictureInPicture(webkitVideo, {}), false);

  const stdDoc = {
    pictureInPictureEnabled: true,
    pictureInPictureElement: null,
    async exitPictureInPicture() {
      this.pictureInPictureElement = null;
    },
  };
  const stdVideo = {
    async requestPictureInPicture() {
      stdDoc.pictureInPictureElement = this;
    },
  };
  assert.equal(isVideoInPictureInPicture(null, stdDoc), false);
  assert.equal(isVideoInPictureInPicture(undefined, stdDoc), false);
  assert.equal(await toggleVideoPictureInPicture(stdVideo, stdDoc), 'entered');
  assert.equal(isVideoInPictureInPicture(stdVideo, stdDoc), true);
  assert.equal(await toggleVideoPictureInPicture(stdVideo, stdDoc), 'exited');
  assert.equal(isVideoInPictureInPicture(stdVideo, stdDoc), false);

  assert.equal(await toggleVideoPictureInPicture(null, {}), 'unsupported');
  assert.equal(await toggleVideoPictureInPicture({}, {}), 'unsupported');
  assert.equal(
    await toggleVideoPictureInPicture(
      {
        webkitSupportsPresentationMode: () => false,
        webkitSetPresentationMode: () => {},
      },
      {},
    ),
    'unsupported',
  );

  // Also verify default navigator-backed iOS detection in mediaCapabilities.ts
  const { isIosUserAgent, hlsPlaybackPath } = await load('mediaCapabilities.js');
  assert.equal(isIosUserAgent(), true);
  assert.equal(isIosUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), true);
  assert.equal(isIosUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), false);
  // Explicit ua without maxTouchPoints must NOT leak global navigator.maxTouchPoints (5)
  assert.equal(isIosUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), false);
  const iosNativeVideo = {
    canPlayType: (type) => (/mpegurl/i.test(type) ? 'maybe' : ''),
  };
  assert.equal(hlsPlaybackPath(iosNativeVideo), 'native');

  // 4. VideoSurface PiP visibility protection & x-webkit-airplay check
  setMockNavigator({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    maxTouchPoints: 0,
  });
  const vsBundle = await build({
    entryPoints: ['src/components/VideoSurface.tsx'],
    outdir: 'unused',
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    plugins: [
      {
        name: 'vs-pip-fixture',
        setup(b) {
          b.onResolve(
            { filter: /^(react|hls\.js)|\/plugins\/(client|playbackTiming)$/ },
            (args) => ({ path: args.path, namespace: 'vs-fixture' }),
          );
          b.onLoad({ filter: /.*/, namespace: 'vs-fixture' }, ({ path }) => {
            if (path === 'react') {
              return {
                contents: `export const forwardRef = (f) => f;
                  export const useRef = (v) => globalThis.vsFixture.useRef(v);
                  export const useEffect = (f, d) => globalThis.vsFixture.useEffect(f, d);
                  export const useImperativeHandle = (ref, f) => { if (ref) ref.current = f(); };`,
              };
            }
            if (path === 'react/jsx-runtime') {
              return {
                contents: `export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;`,
              };
            }
            if (path.includes('worker')) {
              return { contents: `export default 'worker.js';` };
            }
            if (path === 'hls.js') {
              return {
                contents: `export default class MockHls {
                  static isSupported() { return true; }
                  static getMediaSource() { return { isTypeSupported: () => true }; }
                  static Events = { ERROR: 'hlsError' };
                  constructor() { globalThis.vsFixture.hlsInstances.push(this); }
                  loadSource() {}
                  attachMedia() {}
                  on() {}
                  startLoad() { globalThis.vsFixture.hlsStartLoads += 1; }
                  stopLoad() { globalThis.vsFixture.hlsStopLoads += 1; }
                  destroy() {}
                }`,
              };
            }
            if (path.endsWith('client')) {
              return { contents: `export const pluginCommand = async () => {};` };
            }
            return { contents: `export const playbackTiming = () => {};` };
          });
        },
      },
    ],
  });
  const vsCode = vsBundle.outputFiles.find((f) => f.path.endsWith('VideoSurface.js'));
  assert.ok(vsCode, 'Expected bundled output for VideoSurface.js');
  const { default: VideoSurface } = await import(
    `data:text/javascript;base64,${Buffer.from(vsCode.text).toString('base64')}`
  );

  const origDoc = globalThis.document;
  const origWin = globalThis.window;
  try {
    const doc = Object.assign(new EventTarget(), {
      hidden: false,
      pictureInPictureElement: null,
      createElement: () => ({ canPlayType: () => '' }),
    });
    globalThis.document = doc;
    globalThis.window = Object.assign(new EventTarget(), { setTimeout, clearTimeout });

    class MockVideo extends EventTarget {
      paused = false;
      readyState = 4;
      currentTime = 12;
      duration = 100;
      ended = false;
      muted = false;
      volume = 1;
      playbackRate = 1;
      webkitPresentationMode = 'inline';
      playCalls = 0;
      pauseCalls = 0;
      play() {
        this.playCalls += 1;
        this.paused = false;
        return Promise.resolve();
      }
      pause() {
        this.pauseCalls += 1;
        this.paused = true;
      }
      removeAttribute() {}
      load() {}
    }

    const mountVideoSurface = () => {
      const video = new MockVideo();
      const handle = { current: null };
      let cursor = 0;
      const refs = [];
      const effects = new Map();
      let queued = [];
      let props = {
        media: { sessionId: 's1', version: 0, url: 'https://example.com/a.m3u8', format: 'hls', playback: {} },
        position: 0,
        active: true,
        autoPlay: true,
        muted: true,
        volume: 1,
        rate: 1,
        fit: 'contain',
        scale: 1,
        panX: 0,
        panY: 0,
        isGesturing: false,
        onPlaying() {},
        onPause() {},
        onWaiting() {},
        onError() {},
        onTime() {},
        onDuration() {},
        onSize() {},
        onBuffered() {},
        onClick() {},
      };
      globalThis.vsFixture = {
        hlsInstances: [],
        hlsStartLoads: 0,
        hlsStopLoads: 0,
        useRef(value) {
          const i = cursor++;
          return (refs[i] ??= { current: i === 0 ? video : value });
        },
        useEffect(run, deps) {
          const i = cursor++;
          const old = effects.get(i);
          if (!old || deps.some((v, n) => v !== old.deps[n])) {
            queued.push(() => {
              old?.cleanup?.();
              effects.set(i, { deps, cleanup: run() });
            });
          }
        },
      };
      const render = (update = {}) => {
        props = { ...props, ...update };
        cursor = 0;
        queued = [];
        const tree = VideoSurface(props, handle);
        for (const fn of queued) fn();
        return tree;
      };
      const tree = render();
      return { video, doc, render, cleanup: () => { for (const e of effects.values()) e.cleanup?.(); }, tree };
    };

    const vs1 = mountVideoSurface();
    assert.equal(vs1.tree.props.children.props['x-webkit-airplay'], 'allow');
    // WebKit PiP active: visibilitychange to hidden must NOT pause or stopLoad
    vs1.video.webkitPresentationMode = 'picture-in-picture';
    vs1.doc.hidden = true;
    vs1.doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(vs1.video.pauseCalls, 0);
    assert.equal(globalThis.vsFixture.hlsStopLoads, 0);
    // Re-render while hidden & in WebKit PiP must also keep playing
    vs1.render({ muted: false });
    assert.equal(vs1.video.pauseCalls, 0);
    // Standard Document PiP active: hiding must also keep playing
    vs1.video.webkitPresentationMode = 'inline';
    vs1.doc.pictureInPictureElement = vs1.video;
    vs1.doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(vs1.video.pauseCalls, 0);
    assert.equal(globalThis.vsFixture.hlsStopLoads, 0);
    // Exiting PiP while hidden MUST pause and stopLoad
    vs1.doc.pictureInPictureElement = null;
    vs1.doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(vs1.video.pauseCalls, 1);
    assert.equal(globalThis.vsFixture.hlsStopLoads, 1);
    vs1.cleanup();
  } finally {
    globalThis.document = origDoc;
    globalThis.window = origWin;
  }

  // 5. Optional/CI integration check against scripts/verify-ios-ipa.mjs
  const verifyIpaUrl = new URL('./verify-ios-ipa.mjs', import.meta.url);
  if (existsSync(verifyIpaUrl)) {
    const { verifyIpaBuffer } = await import(verifyIpaUrl.href);

    const makePlist = ({
      executable = 'HGhub',
      bundleId = 'com.hghub.player',
      displayName = 'HGhub',
      backgroundAudio = true,
      arbitraryLoads = true,
      orientations = true,
    } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${executable}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleDisplayName</key>
  <string>${displayName}</string>
  <key>UIBackgroundModes</key>
  <array>${backgroundAudio ? '<string>audio</string>' : ''}</array>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <${arbitraryLoads ? 'true' : 'false'}/>
  </dict>
  <key>UISupportedInterfaceOrientations</key>
  <array>${orientations ? '<string>UIInterfaceOrientationPortrait</string><string>UIInterfaceOrientationLandscapeRight</string>' : ''}</array>
</dict>
</plist>`;

    const encodeBinaryPlist = (root) => {
      const objects = [];
      const addObj = (val) => {
        const idx = objects.length;
        objects.push(null);
        if (typeof val === 'boolean') {
          objects[idx] = Buffer.from([val ? 0x09 : 0x08]);
        } else if (typeof val === 'string') {
          const isAscii = /^[\x00-\x7f]*$/.test(val);
          if (isAscii) {
            const strBuf = Buffer.from(val, 'latin1');
            const lenBytes =
              strBuf.length < 15
                ? Buffer.from([0x50 | strBuf.length])
                : Buffer.from([0x5f, 0x10, strBuf.length]);
            objects[idx] = Buffer.concat([lenBytes, strBuf]);
          } else {
            const u16 = Buffer.from(val, 'utf16le');
            u16.swap16();
            const charCount = u16.length / 2;
            const lenBytes =
              charCount < 15
                ? Buffer.from([0x60 | charCount])
                : Buffer.from([0x6f, 0x10, charCount]);
            objects[idx] = Buffer.concat([lenBytes, u16]);
          }
        } else if (Array.isArray(val)) {
          const refs = Buffer.from(val.map((item) => addObj(item)));
          const lenBytes =
            val.length < 15
              ? Buffer.from([0xa0 | val.length])
              : Buffer.from([0xaf, 0x10, val.length]);
          objects[idx] = Buffer.concat([lenBytes, refs]);
        } else if (val && typeof val === 'object') {
          const entries = Object.entries(val);
          const keyRefs = Buffer.from(entries.map(([k]) => addObj(k)));
          const valRefs = Buffer.from(entries.map(([, v]) => addObj(v)));
          const lenBytes =
            entries.length < 15
              ? Buffer.from([0xd0 | entries.length])
              : Buffer.from([0xdf, 0x10, entries.length]);
          objects[idx] = Buffer.concat([lenBytes, keyRefs, valRefs]);
        } else {
          throw new Error(`Unsupported bplist test value: ${String(val)}`);
        }
        return idx;
      };
      addObj(root);
      const chunks = [Buffer.from('bplist00', 'ascii')];
      const offsets = [];
      let cursor = 8;
      for (const obj of objects) {
        offsets.push(cursor);
        chunks.push(obj);
        cursor += obj.length;
      }
      const offsetTableOffset = cursor;
      const offsetTable = Buffer.alloc(offsets.length * 2);
      offsets.forEach((off, i) => offsetTable.writeUInt16BE(off, i * 2));
      chunks.push(offsetTable);
      const trailer = Buffer.alloc(32, 0);
      trailer[6] = 2; // offsetIntSize
      trailer[7] = 1; // objectRefSize
      trailer.writeBigUInt64BE(BigInt(objects.length), 8);
      trailer.writeBigUInt64BE(0n, 16);
      trailer.writeBigUInt64BE(BigInt(offsetTableOffset), 24);
      chunks.push(trailer);
      return Buffer.concat(chunks);
    };

    const makeArm64MachO = (extra = Buffer.alloc(0)) => {
      const buf = Buffer.alloc(32, 0);
      buf.writeUInt32LE(0xfeedfacf, 0);
      buf.writeInt32LE(0x0100000c, 4);
      return Buffer.concat([buf, extra]);
    };

    const makeIpa = ({ plistBuf = Buffer.from(makePlist(), 'utf8'), exeBuf = makeArm64MachO(), extraFiles = [] } = {}) => {
      const zip = new AdmZip();
      zip.addFile('Payload/HGhub.app/Info.plist', plistBuf);
      zip.addFile('Payload/HGhub.app/HGhub', exeBuf);
      for (const [name, data] of extraFiles) {
        zip.addFile(name, data);
      }
      return zip.toBuffer();
    };

    const summary = verifyIpaBuffer(makeIpa());
    assert.equal(summary.bundleId, 'com.hghub.player');
    assert.equal(summary.displayName, 'HGhub');
    assert.equal(summary.executable, 'HGhub');

    // Binary plist (bplist00) with UTF-16BE displayName and >15-char extended length string
    const bplistData = encodeBinaryPlist({
      CFBundleExecutable: 'HGhub',
      CFBundleIdentifier: 'com.hghub.player.custom',
      CFBundleDisplayName: '黄果播放器iOS',
      UIBackgroundModes: ['audio'],
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      UISupportedInterfaceOrientations: [
        'UIInterfaceOrientationPortrait',
        'UIInterfaceOrientationLandscapeLeft',
      ],
    });
    const bplistSummary = verifyIpaBuffer(
      makeIpa({
        plistBuf: bplistData,
        extraFiles: [
          ['Payload/HGhub.app/Frameworks/Sample.framework/Info.plist', Buffer.from(makePlist(), 'utf8')],
        ],
      }),
    );
    assert.equal(bplistSummary.bundleId, 'com.hghub.player.custom');
    assert.equal(bplistSummary.displayName, '黄果播放器iOS');

    assert.throws(() =>
      verifyIpaBuffer(makeIpa({ extraFiles: [['Payload/HGhub.app/.DS_Store', Buffer.from('x')]] })),
    );
    assert.throws(() =>
      verifyIpaBuffer(makeIpa({ extraFiles: [['Payload/HGhub.app/._HGhub', Buffer.from('x')]] })),
    );
    assert.throws(() =>
      verifyIpaBuffer(makeIpa({ extraFiles: [['__MACOSX/Payload/._HGhub', Buffer.from('x')]] })),
    );
    assert.throws(() =>
      verifyIpaBuffer(makeIpa({ plistBuf: Buffer.from(makePlist({ backgroundAudio: false }), 'utf8') })),
    );
    assert.throws(() =>
      verifyIpaBuffer(makeIpa({ plistBuf: Buffer.from(makePlist({ arbitraryLoads: false }), 'utf8') })),
    );
    assert.throws(() =>
      verifyIpaBuffer(makeIpa({ plistBuf: Buffer.from(makePlist({ orientations: false }), 'utf8') })),
    );
    assert.throws(() =>
      verifyIpaBuffer(
        makeIpa({ exeBuf: makeArm64MachO(Buffer.from('http://localhost:1420', 'utf8')) }),
      ),
    );

    const x64MachO = Buffer.alloc(32, 0);
    x64MachO.writeUInt32LE(0xfeedfacf, 0);
    x64MachO.writeInt32LE(0x01000007, 4);
    assert.throws(() => verifyIpaBuffer(makeIpa({ exeBuf: x64MachO })));

    // Inject a 0x5455 Unix extra field into the last Local File Header and adjust EOCD cdOffset
    const baseBuf = makeIpa();
    const lfhSig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const cdSig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    const lastLfh = baseBuf.lastIndexOf(lfhSig);
    const eocd = baseBuf.lastIndexOf(eocdSig);
    assert.ok(lastLfh >= 0 && eocd > lastLfh);
    const nameLen = baseBuf.readUInt16LE(lastLfh + 26);
    const extraLen = baseBuf.readUInt16LE(lastLfh + 28);
    const insertAt = lastLfh + 30 + nameLen + extraLen;
    const unixExtra = Buffer.from([0x55, 0x54, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00]);
    const withExtra = Buffer.concat([
      baseBuf.subarray(0, insertAt),
      unixExtra,
      baseBuf.subarray(insertAt),
    ]);
    withExtra.writeUInt16LE(extraLen + unixExtra.length, lastLfh + 28);
    const newEocd = eocd + unixExtra.length;
    withExtra.writeUInt32LE(withExtra.readUInt32LE(newEocd + 16) + unixExtra.length, newEocd + 16);
    assert.throws(() => verifyIpaBuffer(withExtra));

    // Inject a 0x7875 Info-ZIP New Unix extra field into the first Central Directory header
    const cdBuf = makeIpa();
    const firstCd = cdBuf.indexOf(cdSig);
    const cdEocd = cdBuf.lastIndexOf(eocdSig);
    assert.ok(firstCd >= 0 && cdEocd > firstCd);
    const cdNameLen = cdBuf.readUInt16LE(firstCd + 28);
    const cdExtraLen = cdBuf.readUInt16LE(firstCd + 30);
    const cdInsertAt = firstCd + 46 + cdNameLen + cdExtraLen;
    const newUnixExtra = Buffer.from([0x75, 0x78, 0x04, 0x00, 0x01, 0x01, 0x00, 0x00]);
    const withCdExtra = Buffer.concat([
      cdBuf.subarray(0, cdInsertAt),
      newUnixExtra,
      cdBuf.subarray(cdInsertAt),
    ]);
    withCdExtra.writeUInt16LE(cdExtraLen + newUnixExtra.length, firstCd + 30);
    const updatedCdEocd = cdEocd + newUnixExtra.length;
    withCdExtra.writeUInt32LE(
      withCdExtra.readUInt32LE(updatedCdEocd + 12) + newUnixExtra.length,
      updatedCdEocd + 12,
    );
    assert.throws(() => verifyIpaBuffer(withCdExtra));

    console.log('iOS compat tests passed (including verify-ios-ipa checks)');
  } else {
    if (process.env.CI) {
      throw new Error('scripts/verify-ios-ipa.mjs is missing in CI');
    }
    console.log('iOS compat frontend tests passed (verify-ios-ipa.mjs not present yet)');
  }
} finally {
  restoreNavigator();
}
