/* ═══════════ Mon budget mensuel — v4 : robuste ═══════════
   Écritures ciblées + temps réel, flush des saisies, gestion des accès côté
   propriétaire, mot de passe oublié, vérification e-mail, suppression annulable. */
import { FIREBASE_CONFIG } from './firebase-config.js';

/* ---------- petits outils ---------- */
const $ = s => document.querySelector(s);
const eur = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const fc0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const f = n => eur.format(n || 0);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sum = (a, k) => a.reduce((t, x) => t + (+x[k] || 0), 0);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const low = s => String(s || '').trim().toLowerCase();

/* ---------- catégories ---------- */
const CATS = [
  { id: 'alimentation', label: 'Alimentation', e: '🥐',  c: '#E2B45A' },
  { id: 'logement',     label: 'Logement',     e: '🏠',  c: '#7FB4E6' },
  { id: 'transport',    label: 'Transport',    e: '🚇',  c: '#59D69F' },
  { id: 'loisirs',      label: 'Loisirs',      e: '🎬',  c: '#E98AC2' },
  { id: 'sante',        label: 'Santé',        e: '💊',  c: '#F2705C' },
  { id: 'shopping',     label: 'Shopping',     e: '🛍️', c: '#C9A6FF' },
  { id: 'abonnements',  label: 'Abonnements',  e: '📺',  c: '#6FD6C7' },
  { id: 'autre',        label: 'Autre',        e: '🧾',  c: '#9DB3A6' },
];
const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));
const catOf = v => CAT[v] || CATS.find(c => c.label === v) || CAT.autre;

/* ---------- Firebase ---------- */
let USE_FIREBASE = /^AIza/.test(FIREBASE_CONFIG.apiKey || '');
const F = {};
if (USE_FIREBASE) {
  try {
    const v = '10.12.5';
    const [appM, authM, fsM] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${v}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${v}/firebase-auth.js`),
      import(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore.js`),
    ]);
    const app = appM.initializeApp(FIREBASE_CONFIG);
    F.authM = authM; F.fsM = fsM;
    F.auth = authM.getAuth(app);
    F.db = fsM.getFirestore(app);
  } catch (err) {
    console.error('Firebase indisponible, repli en mode local.', err);
    USE_FIREBASE = false;
  }
}

/* ---------- état du budget ---------- */
const now0 = new Date();
let data = { income: [], fixed: [], plans: {} };
let ym = `${now0.getFullYear()}-${String(now0.getMonth() + 1).padStart(2, '0')}`;
let tab = 'fixes';
const plans = () => data.plans[ym] || (data.plans[ym] = []);
function shift(d) { const p = ym.split('-'); const dt = new Date(+p[0], +p[1] - 1 + d, 1); ym = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0'); render(); }
function mname() { const p = ym.split('-'); return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }); }
const planPayload = it => ({ name: it.name, cat: it.cat, amount: +it.amount || 0, real: it.real == null ? '' : it.real, month: it.month || ym, ts: it.ts || Date.now() });

/* ---------- écritures suivies + flush : aucune frappe perdue ---------- */
const inflight = new Set();
async function write(fn) {
  const p = (async () => { await fn(); })();
  inflight.add(p);
  try { await p; }
  catch (err) { console.error(err); toast(frErr(err)); }
  finally { inflight.delete(p); }
}
function commitFocusedReal() {
  const ae = document.activeElement;
  if (!ae || !ae.dataset || !ae.dataset.real || !store.canWrite) return;
  const id = ae.dataset.real;
  const v = ae.value === '' ? '' : parseFloat(ae.value);
  const it = plans().find(x => x.id === id);
  if (!it || it.real === v || (v !== '' && isNaN(v))) return;
  it.real = v;
  write(() => store.updateItem('plans', id, { real: v }));
}
function flushSaves() { commitFocusedReal(); if (inflight.size) Promise.allSettled([...inflight]); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSaves(); });
window.addEventListener('pagehide', flushSaves);

/* ---------- couche données ---------- */
const store = {
  user: null, currentView: 'self', linkedAccounts: [], sharedWith: [], pendingSent: [],
  _uids: {}, _unsubs: [], _targetUid: null, _recovering: false,

  async init() {
    if (USE_FIREBASE) {
      return new Promise(res => F.authM.onAuthStateChanged(F.auth, async u => {
        this.user = u;
        if (u) { await this.ensureProfile(); await this.loadLinkedAccounts(); }
        res(u);
      }));
    }
    const s = localStorage.getItem('solde.session');
    this.user = s ? { email: s, emailVerified: true } : null;
    if (this.user) await this.loadLinkedAccounts();
    return this.user;
  },

  async register(email, pass) {
    if (USE_FIREBASE) {
      await F.authM.createUserWithEmailAndPassword(F.auth, email, pass);
      this.user = F.auth.currentUser;
      try { await F.authM.sendEmailVerification(this.user); } catch (e) { console.warn(e); }
      await this.ensureProfile();
    } else {
      if (pass.length < 6) throw new Error("Mot de passe : 6 caractères minimum.");
      const users = JSON.parse(localStorage.getItem('solde.users') || '{}');
      if (users[email]) throw new Error("Un compte existe déjà avec cet e-mail.");
      users[email] = { pass: btoa(pass) };
      localStorage.setItem('solde.users', JSON.stringify(users));
      localStorage.setItem('solde.session', email);
      this.user = { email, emailVerified: true };
    }
    await this.loadLinkedAccounts();
  },

  async login(email, pass) {
    if (USE_FIREBASE) {
      await F.authM.signInWithEmailAndPassword(F.auth, email, pass);
      this.user = F.auth.currentUser;
      await this.ensureProfile();
    } else {
      const users = JSON.parse(localStorage.getItem('solde.users') || '{}');
      if (!users[email] || users[email].pass !== btoa(pass)) throw new Error("E-mail ou mot de passe incorrect.");
      localStorage.setItem('solde.session', email);
      this.user = { email, emailVerified: true };
    }
    await this.loadLinkedAccounts();
  },

  async resetPassword(email) {
    if (!USE_FIREBASE) throw new Error("Mode démo : réinitialisation indisponible.");
    await F.authM.sendPasswordResetEmail(F.auth, email);
  },
  async resendVerification() {
    if (USE_FIREBASE && F.auth.currentUser) await F.authM.sendEmailVerification(F.auth.currentUser);
  },
  async refreshVerification() {
    if (!USE_FIREBASE || !F.auth.currentUser) return;
    await F.authM.reload(F.auth.currentUser);
    this.user = F.auth.currentUser;
    await this.user.getIdToken(true);
    await this.ensureProfile();
  },
  get verified() { return !USE_FIREBASE || !!(this.user && this.user.emailVerified); },

  async logout() {
    this.closeData();
    if (USE_FIREBASE) await F.authM.signOut(F.auth);
    else localStorage.removeItem('solde.session');
    this.user = null; this.linkedAccounts = []; this.sharedWith = []; this.pendingSent = [];
    this.currentView = 'self';
  },

  get uid() { return USE_FIREBASE ? this.user.uid : 'local'; },
  get email() { return (this.user && this.user.email) || 'local'; },
  get isSelf() { return this.currentView === 'self'; },
  get currentLink() { return this.linkedAccounts.find(l => l.ownerEmail === this.currentView) || null; },
  get canWrite() { return this.isSelf || (this.currentLink ? this.currentLink.permissions === 'write' : false); },
  get viewEmail() { return this.isSelf ? this.email : this.currentView; },

  async ensureProfile() {
    if (!USE_FIREBASE) return;
    try {
      const { doc, setDoc } = F.fsM;
      await setDoc(doc(F.db, 'profiles', this.uid),
        { email: this.email, emailLower: low(this.email), verified: !!this.user.emailVerified }, { merge: true });
    } catch (e) { console.warn('Profil non publié :', e); }
  },

  async resolveUser(email) {
    if (!USE_FIREBASE) return { uid: email, email };
    const key = low(email);
    if (this._uids[key]) return this._uids[key];
    const { collection, query, where, getDocs } = F.fsM;
    let snap = await getDocs(query(collection(F.db, 'profiles'), where('emailLower', '==', key)));
    if (snap.empty) snap = await getDocs(query(collection(F.db, 'profiles'), where('email', '==', email.trim())));
    if (snap.empty) throw new Error("Compte introuvable : la personne doit se connecter au moins une fois.");
    const d = snap.docs[0].data();
    const res = { uid: snap.docs[0].id, email: d.email || email.trim() };
    this._uids[key] = res;
    return res;
  },

  /* ========== INVITATIONS ========== */
  async sendInvitation(toEmail, permissions) {
    const target = await this.resolveUser(toEmail);
    if (target.uid === this.uid) throw new Error("Vous ne pouvez pas vous inviter vous-même.");
    if (USE_FIREBASE) {
      const { doc, getDoc, setDoc } = F.fsM;
      const link = await getDoc(doc(F.db, 'linkedAccounts', `${this.uid}__${target.uid}`));
      if (link.exists()) throw new Error("Cette personne a déjà accès à votre budget.");
      const ref = doc(F.db, 'invitations', `${this.uid}__${low(target.email)}`);
      const ex = await getDoc(ref);
      if (ex.exists() && ex.data().status === 'pending') throw new Error("Une invitation est déjà en attente pour cet e-mail.");
      await setDoc(ref, { fromUid: this.uid, fromEmail: this.email, toUid: target.uid, toEmail: target.email,
        permissions, status: 'pending', timestamp: Date.now() });
    } else {
      const inv = JSON.parse(localStorage.getItem('solde.invitations') || '[]');
      if (inv.some(i => i.fromEmail === this.email && low(i.toEmail) === low(target.email) && i.status === 'pending'))
        throw new Error("Une invitation est déjà en attente pour cet e-mail.");
      inv.push({ id: `${this.uid}__${low(target.email)}`, fromUid: this.uid, fromEmail: this.email, toUid: target.uid,
        toEmail: target.email, permissions, status: 'pending', timestamp: Date.now() });
      localStorage.setItem('solde.invitations', JSON.stringify(inv));
    }
    await this.loadSharedWith();
  },

  async getPendingInvitations() {
    if (USE_FIREBASE) {
      const { collection, query, where, getDocs } = F.fsM;
      const snap = await getDocs(query(collection(F.db, 'invitations'),
        where('toEmail', '==', this.email), where('status', '==', 'pending')));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    const inv = JSON.parse(localStorage.getItem('solde.invitations') || '[]');
    return inv.filter(i => low(i.toEmail) === low(this.email) && i.status === 'pending');
  },

  async respondToInvitation(inv, accept) {
    if (inv.fromUid && inv.id !== `${inv.fromUid}__${low(this.email)}`)
      throw new Error("Invitation d'une ancienne version : demandez à la personne de vous la renvoyer.");
    if (USE_FIREBASE) {
      const { doc, updateDoc, setDoc } = F.fsM;
      await updateDoc(doc(F.db, 'invitations', inv.id), { status: accept ? 'accepted' : 'refused' });
      if (accept) {
        await setDoc(doc(F.db, 'linkedAccounts', `${inv.fromUid}__${this.uid}`), {
          ownerUid: inv.fromUid, linkedUid: this.uid, ownerEmail: inv.fromEmail, linkedEmail: this.email,
          permissions: inv.permissions, status: 'accepted', timestamp: Date.now()
        });
      }
    } else {
      const all = JSON.parse(localStorage.getItem('solde.invitations') || '[]');
      const item = all.find(i => i.id === inv.id);
      if (!item) throw new Error("Invitation introuvable.");
      item.status = accept ? 'accepted' : 'refused';
      localStorage.setItem('solde.invitations', JSON.stringify(all));
      if (accept) {
        const linked = JSON.parse(localStorage.getItem('solde.linked') || '[]');
        linked.push({ id: `${inv.fromUid}__${this.uid}`, ownerUid: inv.fromUid, linkedUid: this.uid,
          ownerEmail: inv.fromEmail, linkedEmail: this.email, permissions: inv.permissions,
          status: 'accepted', timestamp: Date.now() });
        localStorage.setItem('solde.linked', JSON.stringify(linked));
      }
    }
    await this.loadLinkedAccounts();
  },

  async cancelInvitation(id) {
    if (USE_FIREBASE) { const { doc, deleteDoc } = F.fsM; await deleteDoc(doc(F.db, 'invitations', id)); }
    else {
      const all = JSON.parse(localStorage.getItem('solde.invitations') || '[]');
      localStorage.setItem('solde.invitations', JSON.stringify(all.filter(i => i.id !== id)));
    }
    await this.loadSharedWith();
  },

  /* comptes auxquels j'ai accès */
  async loadLinkedAccounts() {
    if (USE_FIREBASE) {
      const { collection, query, where, getDocs } = F.fsM;
      const snap = await getDocs(query(collection(F.db, 'linkedAccounts'), where('linkedUid', '==', this.uid)));
      this.linkedAccounts = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => (l.status || 'accepted') === 'accepted');
    } else {
      const linked = JSON.parse(localStorage.getItem('solde.linked') || '[]');
      this.linkedAccounts = linked.filter(l => low(l.linkedEmail) === low(this.email));
    }
  },

  /* personnes qui ont accès à MON budget */
  async loadSharedWith() {
    if (!this.isSelf) { this.sharedWith = []; this.pendingSent = []; return; }
    if (USE_FIREBASE) {
      const { collection, query, where, getDocs } = F.fsM;
      const snap = await getDocs(query(collection(F.db, 'linkedAccounts'), where('ownerUid', '==', this.uid)));
      this.sharedWith = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const inv = await getDocs(query(collection(F.db, 'invitations'),
        where('fromUid', '==', this.uid), where('status', '==', 'pending')));
      this.pendingSent = inv.docs.map(d => ({ id: d.id, ...d.data() }));
    } else {
      const linked = JSON.parse(localStorage.getItem('solde.linked') || '[]');
      this.sharedWith = linked.filter(l => l.ownerUid === this.uid);
      const all = JSON.parse(localStorage.getItem('solde.invitations') || '[]');
      this.pendingSent = all.filter(i => i.fromUid === this.uid && i.status === 'pending');
    }
  },

  async removeLink(linkId) {
    if (USE_FIREBASE) { const { doc, deleteDoc } = F.fsM; await deleteDoc(doc(F.db, 'linkedAccounts', linkId)); }
    else {
      const linked = JSON.parse(localStorage.getItem('solde.linked') || '[]');
      localStorage.setItem('solde.linked', JSON.stringify(linked.filter(l => l.id !== linkId)));
    }
    const gone = this.linkedAccounts.find(l => l.id === linkId);
    if (gone && gone.ownerEmail === this.currentView) this.currentView = 'self';
    await this.loadLinkedAccounts();
    await this.loadSharedWith();
  },

  /* ========== DONNÉES : 1 document par ligne + temps réel ========== */
  _localKey() { return 'budget.data.' + this.viewEmail; },
  _saveLocal() { localStorage.setItem(this._localKey(), JSON.stringify(data)); },
  closeData() { this._unsubs.forEach(u => { try { u(); } catch (e) {} }); this._unsubs = []; this._targetUid = null; },

  async openData() {
    this.closeData();
    data = { income: [], fixed: [], plans: {} };
    render();
    if (!USE_FIREBASE) {
      const d = JSON.parse(localStorage.getItem(this._localKey()) || 'null') || {};
      data = { income: d.income || [], fixed: d.fixed || [], plans: d.plans || {} };
      render(); return;
    }
    const targetUid = this.isSelf ? this.uid : (await this.resolveUser(this.currentView)).uid;
    this._targetUid = targetUid;
    try { await this.migrateLegacy(targetUid); } catch (e) { console.warn('Migration :', e); }
    const { collection, onSnapshot } = F.fsM;
    ['income', 'fixed', 'plans'].forEach(kind => {
      const un = onSnapshot(collection(F.db, 'users', targetUid, kind), snap => {
        const items = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.ts || 0) - (b.ts || 0));
        if (kind === 'plans') {
          const m = {};
          items.forEach(x => { const k = x.month || ym; (m[k] || (m[k] = [])).push(x); });
          data.plans = m;
        } else data[kind] = items;
        render();
      }, err => {
        console.error('Synchro :', err);
        if (!this.isSelf && !this._recovering) {
          this._recovering = true;
          toast("Accès retiré — retour à votre compte.");
          this.currentView = 'self';
          applyViewMode();
          this.openData().finally(() => { this._recovering = false; });
        } else toast('Synchronisation interrompue : ' + frErr(err));
      });
      this._unsubs.push(un);
    });
  },

  /* migration automatique depuis l'ancien document unique */
  async migrateLegacy(targetUid) {
    if (!this.canWrite) return;
    const { doc, getDoc, writeBatch } = F.fsM;
    const ref = doc(F.db, 'users', targetUid, 'meta', 'budget');
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const old = snap.data();
    if (old.migrated) return;
    const batch = writeBatch(F.db);
    const base = Date.now(); let n = 0;
    (old.income || []).forEach(it => { if (it.id) batch.set(doc(F.db, 'users', targetUid, 'income', it.id), { name: it.name, amount: +it.amount || 0, ts: base + (n++) }); });
    (old.fixed || []).forEach(it => { if (it.id) batch.set(doc(F.db, 'users', targetUid, 'fixed', it.id), { name: it.name, amount: +it.amount || 0, ts: base + (n++) }); });
    Object.keys(old.plans || {}).forEach(month => {
      (old.plans[month] || []).forEach(it => {
        if (it.id) batch.set(doc(F.db, 'users', targetUid, 'plans', it.id),
          { name: it.name, cat: it.cat, amount: +it.amount || 0, real: it.real == null ? '' : it.real, month, ts: base + (n++) });
      });
    });
    batch.set(ref, { migrated: true }, { merge: true });
    await batch.commit();
  },

  _check() { if (!this.canWrite) throw new Error("Mode lecture seule : modification interdite."); },
  async addItem(kind, id, payload) {
    this._check();
    if (USE_FIREBASE) { const { doc, setDoc } = F.fsM; await setDoc(doc(F.db, 'users', this._targetUid, kind, id), payload); }
    else this._saveLocal();
  },
  async updateItem(kind, id, fields) {
    this._check();
    if (USE_FIREBASE) { const { doc, updateDoc } = F.fsM; await updateDoc(doc(F.db, 'users', this._targetUid, kind, id), fields); }
    else this._saveLocal();
  },
  async deleteItem(kind, id) {
    this._check();
    if (USE_FIREBASE) { const { doc, deleteDoc } = F.fsM; await deleteDoc(doc(F.db, 'users', this._targetUid, kind, id)); }
    else this._saveLocal();
  },
};

/* ---------- erreurs en français ---------- */
function frErr(err) {
  const code = err && err.code;
  if (code === 'permission-denied') return "Refusé par les règles Firestore (lecture seule ou e-mail non vérifié ?).";
  const map = {
    'auth/invalid-credential': 'E-mail ou mot de passe incorrect.',
    'auth/user-not-found': 'Aucun compte avec cet e-mail.',
    'auth/wrong-password': 'Mot de passe incorrect.',
    'auth/email-already-in-use': 'Un compte existe déjà avec cet e-mail.',
    'auth/weak-password': 'Mot de passe trop faible (6 caractères minimum).',
    'auth/invalid-email': 'Adresse e-mail invalide.',
    'auth/network-request-failed': 'Connexion internet impossible.',
    'auth/too-many-requests': 'Trop de tentatives, réessayez plus tard.',
  };
  return map[code] || (err && err.message) || 'Erreur inconnue.';
}

/* ---------- écart réel / prévu ---------- */
function gap() { let g = 0, n = 0; plans().forEach(x => { if (x.real !== '' && x.real != null) { g += (+x.real) - (+x.amount); n++; } }); return { g, n }; }
function gapHtml() { const r = gap(); if (!r.n) return '<span class="muted">Aucun montant réel saisi</span>'; const c = r.g > 0 ? 'neg' : (r.g < 0 ? 'eco' : 'pos'); const l = r.g > 0 ? 'dépassement' : (r.g < 0 ? 'économie' : 'pile dans le budget'); return '<span><b class="' + c + '">' + (r.g > 0 ? '+' : '') + f(r.g) + '</b> <span class="muted">' + l + '</span></span>'; }

/* ---------- résumé (donut) ---------- */
function renderSum() {
  const inc = sum(data.income, 'amount'), fix = sum(data.fixed, 'amount'), pl = sum(plans(), 'amount');
  const rest = inc - fix - pl;
  const base = Math.max(inc, fix + pl, 1);
  const segs = [[fix, 'var(--c1)'], [pl, 'var(--c2)'], [Math.max(rest, 0), 'var(--c3)']];
  let off = 0, arcs = '<circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--soft)" stroke-width="6"/>';
  segs.forEach(s => { const p = s[0] / base * 100; if (p > 0) { arcs += '<circle cx="21" cy="21" r="15.9155" fill="none" stroke="' + s[1] + '" stroke-width="6" stroke-dasharray="' + p + ' ' + (100 - p) + '" stroke-dashoffset="' + (25 - off) + '"/>'; off += p; } });
  const gp = gap(), gpct = Math.abs(gp.g) / base * 100, gs = (fix + pl) / base * 100;
  if (gp.n && gpct > 0) {
    let gl, gst;
    if (gp.g > 0) { gl = Math.min(gpct, 100); gst = Math.min(gs, 100 - gl); }
    else { gl = Math.min(gpct, pl / base * 100); gst = gs - gl; }
    arcs += '<circle cx="21" cy="21" r="20" fill="none" stroke="' + (gp.g > 0 ? 'var(--neg)' : 'var(--eco)') + '" stroke-width="1.6" pathLength="100" stroke-dasharray="' + gl + ' ' + (100 - gl) + '" stroke-dashoffset="' + (25 - gst) + '"/>';
  }
  $('#mlabel').textContent = mname();
  $('#sum').innerHTML =
    '<div class="pie"><div class="donut"><svg viewBox="0 0 42 42" role="img" aria-label="Répartition des revenus : frais fixes, dépenses prévues et reste">' + arcs + '</svg>' +
    '<div class="mid"><span>' + (rest < 0 ? 'Déficit' : 'Reste à vivre') + '</span><b class="' + (rest < 0 ? 'neg' : 'pos') + '">' + fc0.format(rest) + '</b>' + (gp.n ? '<span class="' + (gp.g > 0 ? 'neg' : 'eco') + '">' + (gp.g > 0 ? '+' : '') + fc0.format(gp.g) + ' d’écart</span>' : '') + '</div></div>' +
    '<div class="legend">' +
    '<div><i style="background:transparent;border:2px solid var(--ink)"></i><span>Revenus</span><b>' + f(inc) + '</b></div>' +
    '<div><i style="--c:var(--c1)"></i><span>Frais fixes</span><b>' + f(fix) + '</b></div>' +
    '<div><i style="--c:var(--c2)"></i><span>Prévu</span><b>' + f(pl) + '</b></div>' +
    '<div><i style="--c:var(--c3)"></i><span>Reste</span><b class="' + (rest < 0 ? 'neg' : '') + '">' + f(rest) + '</b></div>' +
    (gp.n ? '<div><i style="background:transparent;border:2px solid ' + (gp.g > 0 ? 'var(--neg)' : 'var(--eco)') + '"></i><span>Anneau ext. : écart</span><b class="' + (gp.g > 0 ? 'neg' : 'eco') + '">' + (gp.g > 0 ? '+' : '') + f(gp.g) + '</b></div>' : '') + '</div></div>' +
    '<div class="gap"><span>Écart réel / prévu</span>' + gapHtml() + '</div>';
}

/* ---------- revenus / frais fixes ---------- */
function listBlock(title, key, ph, note) {
  const items = data[key], w = store.canWrite;
  let h = '<section class="box"><h2>' + title + '</h2><p class="note">' + note + '</p>';
  if (!items.length) h += '<p class="empty">Rien pour l’instant.' + (w ? ' Ajoutez une ligne ci-dessous.' : '') + '</p>';
  items.forEach(it => {
    h += '<div class="row"><div class="n">' + esc(it.name) + '</div><div class="a">' + f(it.amount) + '</div>' +
      (w ? '<button class="x" data-del="' + key + '" data-id="' + it.id + '" aria-label="Supprimer ' + esc(it.name) + '">×</button>' : '') + '</div>';
  });
  h += '<div class="tot"><span>Total</span><span>' + f(sum(items, 'amount')) + '</span></div>';
  if (w) h += '<form data-add="' + key + '"><input name="name" placeholder="' + ph + '" required maxlength="60" aria-label="Libellé"><input name="amount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Montant €" required aria-label="Montant en euros"><button type="submit">Ajouter</button></form>';
  return h + '</section>';
}

/* ---------- dépenses prévues ---------- */
function renderPlans() {
  const items = plans(), w = store.canWrite;
  let h = '<section class="box"><h2>Dépenses prévues en ' + esc(mname()) + '</h2><p class="note">Indiquez ce que vous comptez dépenser, puis saisissez le montant réel au fil du mois.</p>';
  if (!items.length) h += '<p class="empty">Aucune dépense prévue ce mois-ci.</p>';
  items.forEach(it => {
    const c = catOf(it.cat);
    const d = it.real === '' || it.real == null ? null : (+it.real) - (+it.amount);
    const dl = d === null ? '' : '<span class="delta ' + (d > 0 ? 'neg' : (d < 0 ? 'eco' : 'pos')) + '">' + (d > 0 ? '+' : '') + f(d) + '</span>';
    h += '<div class="row"><div class="n">' + esc(it.name) + '<small>' + c.e + ' ' + esc(c.label) + ' · prévu ' + f(it.amount) + ' ' + dl + '</small></div>' +
      '<input class="real" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Réel" value="' + (it.real == null ? '' : it.real) + '" data-real="' + it.id + '"' + (w ? '' : ' disabled') + ' aria-label="Montant réel pour ' + esc(it.name) + '">' +
      (w ? '<button class="x" data-del="plan" data-id="' + it.id + '" aria-label="Supprimer ' + esc(it.name) + '">×</button>' : '') + '</div>';
  });
  const real = items.reduce((t, x) => t + (x.real === '' || x.real == null ? 0 : +x.real), 0);
  h += '<div class="tot"><span>Prévu</span><span>' + f(sum(items, 'amount')) + '</span></div>';
  h += '<div class="tot" style="border-top:0;padding-top:4px"><span>Dépensé</span><span>' + f(real) + '</span></div>';
  h += '<div class="tot" style="border-top:0;padding-top:4px"><span>Écart réel / prévu</span>' + gapHtml() + '</div>';
  if (w) {
    h += '<form data-add="plan"><input name="name" placeholder="Ex. Courses de la semaine" required maxlength="60" aria-label="Libellé"><select name="cat" aria-label="Catégorie">' + CATS.map(c => '<option value="' + c.id + '">' + c.e + ' ' + c.label + '</option>').join('') + '</select><input name="amount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Prévu €" required aria-label="Montant prévu en euros"><button type="submit">Ajouter</button></form>';
    h += '<div class="foot"><button class="ghost" id="copy">Reprendre le mois précédent</button></div>';
  }
  return h + '</section>';
}

/* ---------- bilan annuel ---------- */
const MN = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
let yr = now0.getFullYear(), pFrom = 1, pTo = 12;
function mdata(y, m) { const it = data.plans[y + '-' + String(m).padStart(2, '0')] || []; const d = { pl: sum(it, 'amount'), n: 0, real: 0, pf: 0 }; it.forEach(x => { if (x.real !== '' && x.real != null) { d.n++; d.real += +x.real; d.pf += +x.amount; } }); d.gap = d.real - d.pf; return d; }
function gcls(g) { return g > 0 ? 'neg' : (g < 0 ? 'eco' : 'pos'); }
function sg(g) { return (g > 0 ? '+' : '') + f(g); }
function card(l, v, c) { return '<div class="card"><span>' + l + '</span><b class="' + (c || '') + '">' + v + '</b></div>'; }
function rect(x, y, w, h, c) { return h > 0 ? '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + c + '" rx="2"/>' : ''; }
function renderYear() {
  const inc = sum(data.income, 'amount'), fix = sum(data.fixed, 'amount');
  const ms = [];
  for (let i = pFrom; i <= pTo; i++) ms.push({ m: i, d: mdata(yr, i) });
  const N = ms.length; let tPl = 0, tGap = 0, tN = 0, tReal = 0;
  ms.forEach(x => { tPl += x.d.pl; tGap += x.d.gap; tN += x.d.n; tReal += x.d.real; });
  const tInc = inc * N, tFix = fix * N, tRest = tInc - tFix - tPl;
  const presets = [['Année', 1, 12], ['T1', 1, 3], ['T2', 4, 6], ['T3', 7, 9], ['T4', 10, 12], ['S1', 1, 6], ['S2', 7, 12]];
  const opts = sel => MN.map((n, k) => '<option value="' + (k + 1) + '"' + (k + 1 === sel ? ' selected' : '') + '>' + n + '</option>').join('');
  const full = pFrom === 1 && pTo === 12;
  let h = '<div class="month" style="margin-bottom:14px"><button class="ghost" data-yr="-1" aria-label="Année précédente">‹</button><b>' + yr + '</b><button class="ghost" data-yr="1" aria-label="Année suivante">›</button></div>';
  h += '<section class="box"><h2>Période</h2><div class="presets">' + presets.map(p => '<button class="chip" data-preset="' + p[1] + '-' + p[2] + '" aria-pressed="' + (p[1] === pFrom && p[2] === pTo) + '">' + p[0] + '</button>').join('') + '</div>';
  h += '<div class="per"><label>Du <select data-sel="from" aria-label="Premier mois">' + opts(pFrom) + '</select></label><label>au <select data-sel="to" aria-label="Dernier mois">' + opts(pTo) + '</select></label><span class="muted">' + N + ' mois</span></div></section>';
  h += '<section class="box"><h2>Bilan ' + (full ? 'de ' + yr : MN[pFrom - 1] + ' – ' + MN[pTo - 1] + ' ' + yr) + '</h2><div class="cards">' + card('Revenus', f(tInc)) + card('Frais', f(tFix)) + card('Dépenses prévues', f(tPl)) + card('Reste prévisionnel', f(tRest), tRest < 0 ? 'neg' : 'pos') + '</div>' +
    '<div class="gap"><span>Écart réel / prévu</span>' + (tN ? '<span><b class="' + gcls(tGap) + '">' + sg(tGap) + '</b> <span class="muted">' + (tGap > 0 ? 'dépassement' : (tGap < 0 ? 'économie' : 'pile dans le budget')) + '</span></span>' : '<span class="muted">Aucun montant réel saisi</span>') + '</div></section>';
  let mx = Math.max(inc, 1);
  ms.forEach(x => { mx = Math.max(mx, fix + x.d.pl, x.d.n ? fix + x.d.real : 0); });
  const L = 62, R = 632, T = 14, B = 214, W = R - L, H = B - T, sw = W / N, bw = Math.min(sw * 0.38, 24);
  const Y = v => B - v / mx * H;
  let s = '<svg viewBox="0 0 640 244" role="img" aria-label="Frais et dépenses par mois, prévu et réel, comparés aux revenus" style="width:100%;min-width:480px;display:block">';
  [0, 0.5, 1].forEach(t => { const y = Y(mx * t); s += '<line x1="' + L + '" x2="' + R + '" y1="' + y + '" y2="' + y + '" stroke="var(--line)"/><text x="' + (L - 6) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="var(--muted)">' + fc0.format(mx * t) + '</text>'; });
  ms.forEach((x, k) => {
    const cx = L + sw * k + sw / 2, d = x.d;
    s += rect(cx - bw - 1, Y(fix), bw, fix / mx * H, 'var(--c1)') + rect(cx - bw - 1, Y(fix + d.pl), bw, d.pl / mx * H, 'var(--c2)');
    if (d.n) { const col = d.gap > 0 ? 'var(--neg)' : (d.gap < 0 ? 'var(--eco)' : 'var(--c3)'); s += rect(cx + 1, Y(fix), bw, fix / mx * H, 'var(--c1)') + rect(cx + 1, Y(fix + d.real), bw, d.real / mx * H, col); }
    s += '<text x="' + cx + '" y="232" text-anchor="middle" font-size="10" fill="var(--muted)">' + MN[x.m - 1] + '</text>';
  });
  if (inc > 0) s += '<line x1="' + L + '" x2="' + R + '" y1="' + Y(inc) + '" y2="' + Y(
