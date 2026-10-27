// AI announcements: the AI says what it's doing out loud, the way players at a table announce their plays
// ("I cast Lightning Bolt targeting your Serra Angel") — and can read the cards it casts. Uses the browser's built-in
// speech (Web Speech API). Setting: off (default) / announce plays / announce plays and read the cards.
import { G, isAI } from './state.js';
import { DB } from './data.js';

export const voiceSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

let voice = null;
function pickVoice() {
  if (!voiceSupported()) return null;
  const vs = window.speechSynthesis.getVoices();
  return vs.find((v) => /^en(-|_)US/i.test(v.lang) && /Google|Natural|Samantha|Aria|Jenny/i.test(v.name)) || vs.find((v) => /^en/i.test(v.lang)) || null;
}
if (voiceSupported()) window.speechSynthesis.onvoiceschanged = () => { voice = pickVoice(); };

let pending = 0;
export function speak(text, opts = {}) {
  if (!voiceSupported() || !text) return;
  const ss = window.speechSynthesis;
  // don't fall far behind the game: if a lot is already waiting, drop what's queued and say the newest
  if (pending > 4 && !opts.keep) { ss.cancel(); pending = 0; }
  const u = new SpeechSynthesisUtterance(text);
  if (!voice) voice = pickVoice();
  if (voice) u.voice = voice;
  u.rate = opts.rate || 1.08;
  u.pitch = 1;
  pending++;
  u.onend = u.onerror = () => { pending = Math.max(0, pending - 1); };
  ss.speak(u);
}
export function stopSpeaking() {
  if (voiceSupported()) window.speechSynthesis.cancel();
  pending = 0;
}

// log lines are HTML; speech wants plain words
const SYMBOL = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colorless', T: 'tap', Q: 'untap', X: 'X', S: 'snow', E: 'energy' };
function words(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\{(\d+)\}/g, '$1 ')
    .replace(/\{([WUBRGCTQXSE])\/([WUBRGP])\}/g, (m, a, b) => `${SYMBOL[a] || a} or ${b === 'P' ? 'two life' : SYMBOL[b] || b} `)
    .replace(/\{([WUBRGCTQXSE])\}/g, (m, a) => `${SYMBOL[a] || a} `)
    .replace(/\bAI\b/g, 'A.I.')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
// the rules text of a card, for "read the cards" (reminder text left out)
function cardText(def) {
  const d = DB[def];
  if (!d) return '';
  const f = d.faces[0] || {};
  const name = d.name.split(' // ')[0];
  const body = (f.oracle || '').replace(/\([^)]*\)/g, '').replace(/\n+/g, '. ').replace(/\.\s*\./g, '.');
  const pt = f.power != null && f.toughness != null ? ` ${f.power} ${f.toughness}.` : '';
  return words(`${name}: ${f.typeLine || ''}.${pt} ${body}`);
}

// which of the AI's log lines are worth saying out loud
const ANNOUNCE = /\b(?:casts?|plays?|activates?|attacks? with|blocks?|triggers?|chapter|resolves?|counters?|copies|becomes? the monarch|takes? the initiative|ventures?|mulligans?|concedes?|wins?|loses?)\b/i;
const SKIP = /\b(?:untaps?|draws? (?:a|\d+) cards? for the turn|tap(?:s)? .* for mana|Unused mana)\b/i;

export function announce(who, html) {
  const mode = (G.settings && G.settings.aiVoice) || 'off';
  if (mode === 'off' || !voiceSupported() || !G.s || G.s.phase !== 'play') return;
  if (!isAI(who)) return;
  const text = words(html);
  if (!text || SKIP.test(text) || !ANNOUNCE.test(text)) return;
  speak(text.length > 220 ? text.slice(0, 217).replace(/\s+\S*$/, '') + '…' : text);
  // "read the cards": a spell or land the AI just cast or played
  if (mode === 'read' && /\bcasts?\b/i.test(text)) {
    const defs = [...String(html).matchAll(/data-def="([^"]+)"/g)].map((m) => m[1]);
    if (defs[0]) speak(cardText(defs[0]), { keep: true, rate: 1.12 });
  }
}

G.voiceHook = announce;
