// Posts every patch-notes entry newer than the version before this push to the Discord webhook.
// Run by .github/workflows/discord-updates.yml. Locally: DRY_RUN=1 BEFORE_SHA=<sha> node .github/scripts/discord-notes.mjs
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const hook = process.env.DISCORD_WEBHOOK_URL;
const dry = !!process.env.DRY_RUN;
if (!hook && !dry) {
  console.log('DISCORD_WEBHOOK_URL is not set; nothing to do.');
  process.exit(0);
}

const now = JSON.parse(readFileSync('package.json', 'utf8')).version;
let before = null;
const sha = process.env.BEFORE_SHA || '';
if (sha && !/^0+$/.test(sha)) {
  try { before = JSON.parse(execSync(`git show ${sha}:package.json`, { encoding: 'utf8' })).version; } catch (e) { before = null; }
}
if (before === now) {
  console.log(`Version unchanged (${now}); nothing to post.`);
  process.exit(0);
}

const notes = JSON.parse(readFileSync('public/patch-notes.json', 'utf8'));
// entries are newest first: take everything above the previous version (at most 10; one if we can't tell)
const fresh = [];
for (const e of notes) {
  if (e.version === before) break;
  fresh.push(e);
  if (!before || fresh.length >= 10) break;
}
if (!fresh.length) {
  console.log('No new patch-notes entries.');
  process.exit(0);
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
for (const e of fresh.reverse()) {
  const body = {
    username: 'EDH Playtester Updates',
    embeds: [{
      title: clip(`v${e.version} — ${e.title || 'Update'}`, 256),
      description: clip((e.notes || []).map((n) => `• ${n}`).join('\n'), 4000),
      color: 0xd3aa52,
    }],
  };
  if (dry) { console.log(JSON.stringify(body, null, 2)); continue; }
  const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    console.error(`Discord answered ${r.status}: ${await r.text()}`);
    process.exit(1);
  }
  console.log(`Posted v${e.version}`);
  await new Promise((res) => setTimeout(res, 1200)); // stay under the webhook rate limit
}
