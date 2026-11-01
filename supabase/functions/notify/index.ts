// Fonction serveur des notifications de l'app Répètes
// - mode « notify »    : appelée par l'app après chaque changement (compte du groupe connecté)
// - mode « reminders » : appelée toutes les 5 minutes par une tâche planifiée (secret partagé)
import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendPush, type Vapid } from './webpush.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const APP_URL = 'https://d4guru.github.io/repetes/';
const GROUP_WINDOW_MIN = 10; // regroupement anti-spam
const MIN_PRESENT = 4;
const TZ = 'Europe/Zurich';
const TYPES = new Set([
  'reh_new', 'reh_edit', 'reh_delete', 'dispo', 'vote_open', 'vote', 'reh_status', 'setlist', 'bilan', 'setlist_note',
  'song_new', 'song_text', 'level', 'perso_note', 'audio', 'cover', 'song_delete', 'group', 'reminder', 'dispo_reminder',
]);
const DEFAULT_REMINDERS = [{ days: 1, time: '18:00' }];
const DEFAULT_DISPO_REMINDERS = [{ days: 3, time: '18:00' }, { days: 1, time: '18:00' }];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Secrets lus dans le coffre-fort de la base (gardés en mémoire)
let secrets: { vapid: Vapid; cron: string } | null = null;
async function getSecrets() {
  if (secrets) return secrets;
  const get = async (n: string) => {
    const { data, error } = await db.rpc('app_secret', { secret_name: n });
    if (error || !data) throw new Error('secret manquant : ' + n);
    return data as string;
  };
  const [priv, pub, cron] = await Promise.all([get('vapid_private'), get('vapid_public'), get('cron_secret')]);
  secrets = { vapid: { privateKey: priv, publicKey: pub, subject: APP_URL }, cron };
  return secrets;
}

type Prefs = { member: string; disabled_types: string[]; reminders: { days: number; time: string }[]; dispo_reminders: { days: number; time: string }[] };
async function loadPrefs(): Promise<Map<string, Prefs>> {
  const { data } = await db.from('notif_prefs').select('*');
  return new Map((data || []).map((p: Prefs) => [p.member, p]));
}
const wants = (prefs: Map<string, Prefs>, member: string, type: string) => !(prefs.get(member)?.disabled_types || []).includes(type);

// Enregistre les notifications et les envoie sur les téléphones des destinataires
async function deliver(rows: { member: string; type: string; title: string; body: string; link: string; actor: string | null; group_key: string | null }[]) {
  if (!rows.length) return { sent: 0, pushed: 0 };
  const { data: inserted, error } = await db.from('notifications').insert(rows).select('id, member, title, body, link, group_key, type');
  if (error) throw error;
  const members = [...new Set(inserted!.map((n) => n.member))];
  const { data: subs } = await db.from('push_subscriptions').select('*').in('member', members);
  const { vapid } = await getSecrets();
  let pushed = 0;
  await Promise.all((subs || []).flatMap((s) => inserted!.filter((n) => n.member === s.member).map(async (n) => {
    try {
      const status = await sendPush(s, { title: n.title, body: n.body, link: n.link, nid: n.id, tag: n.group_key || n.type }, vapid);
      if (status === 404 || status === 410) await db.from('push_subscriptions').delete().eq('id', s.id);
      else if (status >= 200 && status < 300) { pushed++; await db.from('push_subscriptions').update({ last_ok: new Date().toISOString() }).eq('id', s.id); }
      else console.log('push refusé', status, new URL(s.endpoint).host);
    } catch (e) { console.log('push erreur', String(e)); }
  })));
  return { sent: inserted!.length, pushed };
}

// ---------- Mode « notify » ----------
async function handleNotify(p: Record<string, unknown>) {
  const type = String(p.type || '');
  if (!TYPES.has(type)) return json({ error: 'type inconnu' }, 400);
  const actor = String(p.actor || '').slice(0, 60) || null;
  const title = String(p.title || '').slice(0, 120);
  const body = String(p.body || '').slice(0, 300);
  const link = String(p.link || '').slice(0, 200);
  const group_key = p.group_key ? String(p.group_key).slice(0, 200) : null;

  const [{ data: members }, prefs] = await Promise.all([db.from('members').select('name'), loadPrefs()]);
  const recipients = (members || []).map((m) => m.name as string).filter((n) => n !== actor && wants(prefs, n, type));
  if (!recipients.length) return json({ sent: 0 });

  // Même personne, même élément, il y a peu : on met à jour la notification existante, sans nouvelle alerte
  if (group_key && actor) {
    const since = new Date(Date.now() - GROUP_WINDOW_MIN * 60000).toISOString();
    const { data: recent } = await db.from('notifications').select('id, member')
      .eq('group_key', group_key).eq('actor', actor).gte('created_at', since);
    if (recent && recent.length) {
      await db.from('notifications').update({ title, body, link, created_at: new Date().toISOString(), read_at: null })
        .in('id', recent.map((r) => r.id));
      return json({ grouped: recent.length });
    }
  }
  const res = await deliver(recipients.map((member) => ({ member, type, title, body, link, actor, group_key })));
  return json(res);
}

// ---------- Mode « reminders » ----------
function tzOffsetMs(utcMs: number): number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const v = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute, +v.second) - utcMs;
}
// Heure locale de Zurich -> instant UTC (gère l'heure d'été)
function zurichToUtc(dateIso: string, hhmm: string): number {
  const [y, m, d] = dateIso.split('-').map(Number);
  const [h, mi] = (hhmm || '20:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h || 0, mi || 0);
  return guess - tzOffsetMs(guess - tzOffsetMs(guess));
}
function shiftDate(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}
const todayZurich = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const fmtLong = (iso: string) => new Intl.DateTimeFormat('fr-CH', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso + 'T12:00:00Z'));

// Même règle que dans l'app : maintenue si tous les présents votent « On maintient »
function isCancelled(r: any, members: string[]): boolean {
  const av = r.availability || [], votes = r.rehearsal_votes || [];
  const absents = members.filter((m) => av.some((a: any) => a.member === m && a.status === 'non'));
  if (!absents.length) return false;
  const voters = members.filter((m) => !absents.includes(m));
  const pending = members.filter((m) => !av.some((a: any) => a.member === m));
  const vOf = (m: string) => votes.find((v: any) => v.member === m)?.vote;
  const maintain = voters.filter((m) => vOf(m) === 'maintenir');
  const annul = voters.filter((m) => vOf(m) === 'annuler');
  const open = pending.length === 0;
  if (open && voters.length && maintain.length === voters.length) return false;
  return voters.length < MIN_PRESENT || (open && annul.length > 0);
}

async function handleReminders() {
  const now = Date.now();
  const today = todayZurich();
  const [{ data: members }, prefs, { data: rehs }] = await Promise.all([
    db.from('members').select('name'),
    loadPrefs(),
    db.from('rehearsals').select('id, date, time, place, availability(member, status), rehearsal_votes(member, vote)')
      .gte('date', today).lte('date', shiftDate(today, -8)),
  ]);
  const names = (members || []).map((m) => m.name as string);
  const ids = (rehs || []).map((r) => r.id);
  const { data: logs } = ids.length ? await db.from('reminder_log').select('*').in('rehearsal_id', ids) : { data: [] };
  const done = new Set((logs || []).map((l) => `${l.member}|${l.rehearsal_id}|${l.kind}|${l.slot}`));

  const rows: any[] = [], logRows: any[] = [];
  for (const r of rehs || []) {
    if (isCancelled(r, names)) continue;
    const start = zurichToUtc(r.date, r.time || '20:00');
    if (now >= start) continue;
    for (const member of names) {
      const answer = (r.availability || []).find((a: any) => a.member === member)?.status;
      const p = prefs.get(member);
      const kinds: [string, { days: number; time: string }[]][] = [];
      if (answer !== 'non' && wants(prefs, member, 'reminder')) kinds.push(['reminder', p?.reminders ?? DEFAULT_REMINDERS]);
      if (!answer && wants(prefs, member, 'dispo_reminder')) kinds.push(['dispo_reminder', p?.dispo_reminders ?? DEFAULT_DISPO_REMINDERS]);
      for (const [kind, slots] of kinds) {
        for (const s of slots || []) {
          const slot = `${s.days}@${s.time}`;
          const target = zurichToUtc(shiftDate(r.date, Number(s.days) || 0), s.time);
          if (now < target || now >= target + 30 * 60000 || done.has(`${member}|${r.id}|${kind}|${slot}`)) continue;
          done.add(`${member}|${r.id}|${kind}|${slot}`);
          const when = r.date === today ? "aujourd'hui" : r.date === shiftDate(today, -1) ? 'demain' : fmtLong(r.date);
          const details = `${fmtLong(r.date)} à ${r.time || '20:00'}${r.place ? ' · ' + r.place : ''}`;
          rows.push(kind === 'reminder'
            ? { member, type: kind, title: `Rappel : répète ${when}`, body: details, link: `#/repete/${r.id}`, actor: null, group_key: null }
            : { member, type: kind, title: 'Ta dispo ?', body: `Tu n'as pas encore répondu pour la répète ${when === "aujourd'hui" || when === 'demain' ? when : 'du ' + when} (${r.time || '20:00'}).`, link: `#/repete/${r.id}`, actor: null, group_key: null });
          logRows.push({ member, rehearsal_id: r.id, kind, slot });
        }
      }
    }
  }
  if (logRows.length) await db.from('reminder_log').upsert(logRows, { onConflict: 'member,rehearsal_id,kind,slot', ignoreDuplicates: true });
  const res = await deliver(rows);
  return json({ ...res, checked: (rehs || []).length });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'méthode' }, 405);
  try {
    const p = await req.json().catch(() => ({}));
    const { cron } = await getSecrets();
    const internal = req.headers.get('x-cron-secret') === cron;
    if (p.mode === 'reminders') {
      if (!internal) return json({ error: 'non autorisé' }, 401);
      return await handleReminders();
    }
    // Notification normale : réservée au compte du groupe connecté (ou appel interne)
    if (!internal) {
      const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const { data, error } = await db.auth.getUser(token);
      if (error || !data?.user) return json({ error: 'non autorisé' }, 401);
    }
    return await handleNotify(p);
  } catch (e) {
    console.log('erreur', String(e));
    return json({ error: String(e) }, 500);
  }
});
