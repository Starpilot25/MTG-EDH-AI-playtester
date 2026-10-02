#!/usr/bin/env node
// Writes update.json: the version number plus a fingerprint (SHA-256) of every file in public/.
// Upload update.json together with the changed files and installed apps pick the update up on their next start.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = process.argv[2] || pkg.version;
const files = {};
(function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else files[path.relative(root, full).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
})(path.join(root, 'public'));
fs.writeFileSync(path.join(root, 'update.json'), JSON.stringify({ version, minAppVersion: '1.0.0', files }, null, 2) + '\n');
console.log(`update.json: version ${version}, ${Object.keys(files).length} files`);
