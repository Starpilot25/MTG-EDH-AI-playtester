// Live updates for the desktop app: the game itself (everything in public/) is downloaded from the
// GitHub repository when a newer version is published there, so changes don't need a reinstall.
//
// How it works: the repository has update.json (a version number and a SHA-256 fingerprint for every
// game file). On start the app compares it with what it has, downloads only the files that changed,
// checks every fingerprint, and switches over in one step. Offline or anything odd → it keeps using
// the version it already has.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = 'Starpilot25/MTG-EDH-AI-playtester';
const BRANCH = 'main';
const RAW = process.env.EDH_UPDATE_URL || `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const newer = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
const readJSON = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return null;
  }
};

async function get(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { signal: ctl.signal, headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Files may sit in their folders (public/js/ai.js) or, if they were uploaded flat, at the top level (ai.js).
// Whichever copy matches the fingerprint wins, so stale copies elsewhere in the repository don't matter.
async function fetchFile(rel, hash) {
  for (const p of [rel, rel.replace(/^public\//, ''), path.posix.basename(rel)]) {
    const buf = await get(RAW + p);
    if (buf && sha(buf) === hash) return buf;
  }
  return null;
}

/**
 * Returns { dir, version, source } — the public/ folder the server should use.
 * appDir: where the installed app's own files are; dataDir: a writable folder; appVersion: installed version.
 */
async function prepare({ appDir, dataDir, appVersion, log = () => {} }) {
  const bundled = { dir: path.join(appDir, 'public'), version: (readJSON(path.join(appDir, 'update.json')) || {}).version || appVersion, manifest: readJSON(path.join(appDir, 'update.json')) };
  const liveRoot = path.join(dataDir, 'live');
  const liveManifest = readJSON(path.join(liveRoot, 'update.json'));
  let current = bundled;
  if (liveManifest && fs.existsSync(path.join(liveRoot, 'public')) && newer(liveManifest.version, bundled.version))
    current = { dir: path.join(liveRoot, 'public'), version: liveManifest.version, manifest: liveManifest, live: true };

  const remoteBuf = await get(RAW + 'update.json');
  const remote = remoteBuf && (() => {
    try {
      return JSON.parse(remoteBuf.toString('utf8'));
    } catch (e) {
      return null;
    }
  })();
  if (!remote || !remote.files || !newer(remote.version, current.version)) {
    return { dir: current.dir, version: current.version, source: current.live ? 'updated' : 'built-in' };
  }
  if (remote.minAppVersion && newer(remote.minAppVersion, appVersion)) {
    log(`Update ${remote.version} needs a newer app (${remote.minAppVersion}); keeping ${current.version}.`);
    return { dir: current.dir, version: current.version, source: current.live ? 'updated' : 'built-in', needsReinstall: remote.version };
  }
  // build the new version in a staging folder: unchanged files are copied, changed ones downloaded
  const staging = path.join(dataDir, 'live-staging');
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    for (const [rel, hash] of Object.entries(remote.files)) {
      const sub = rel.replace(/^public\//, '');
      const dest = path.join(staging, 'public', sub);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const have = path.join(current.dir, sub);
      if (fs.existsSync(have) && sha(fs.readFileSync(have)) === hash) {
        fs.copyFileSync(have, dest);
        continue;
      }
      const buf = await fetchFile(rel, hash);
      if (!buf) throw new Error(`could not download ${rel}`);
      fs.writeFileSync(dest, buf);
    }
    fs.writeFileSync(path.join(staging, 'update.json'), JSON.stringify(remote, null, 2));
    // swap in the new version
    const old = path.join(dataDir, 'live-old');
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(liveRoot)) fs.renameSync(liveRoot, old);
    fs.renameSync(staging, liveRoot);
    fs.rmSync(old, { recursive: true, force: true });
    log(`Updated the game to ${remote.version}.`);
    return { dir: path.join(liveRoot, 'public'), version: remote.version, source: 'updated', justUpdated: true };
  } catch (e) {
    log('Update skipped: ' + e.message);
    fs.rmSync(staging, { recursive: true, force: true });
    return { dir: current.dir, version: current.version, source: current.live ? 'updated' : 'built-in' };
  }
}

module.exports = { prepare, newer, REPO };
