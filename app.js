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
  if (inc > 0) s += '<line x1="' + L + '" x2="' + R + '" y1="' + Y(inc) + '" y2="' + Y(inc) + '" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="4 3"/>';
  s += '</svg>';
  h += '<section class="box"><h2>Mois par mois</h2><p class="note">Pour chaque mois, la barre de gauche montre le prévu et celle de droite le réel. Le réel ne compte que les dépenses dont vous avez saisi le montant.</p><div class="scroll">' + s + '</div>' +
    '<div class="lg"><span><i style="background:var(--c1)"></i>Frais</span><span><i style="background:var(--c2)"></i>Prévu</span><span><i style="background:var(--c3)"></i>Réel</span><span><i style="background:var(--neg)"></i>Réel au-dessus du prévu</span><span><i style="background:var(--eco)"></i>Réel sous le prévu</span><span><i class="dash"></i>Revenus</span></div></section>';
  const rows = ms.map(x => { const d = x.d; return '<tr><td>' + MN[x.m - 1] + '</td><td>' + f(d.pl) + '</td><td>' + (d.n ? f(d.real) : '—') + '</td><td>' + (d.n ? '<span class="' + gcls(d.gap) + '">' + sg(d.gap) + '</span>' : '—') + '</td><td class="' + (inc - fix - d.pl < 0 ? 'neg' : '') + '">' + f(inc - fix - d.pl) + '</td></tr>'; }).join('');
  h += '<section class="box"><h2>Détail</h2><div class="scroll"><table><thead><tr><th>Mois</th><th>Prévu</th><th>Réel</th><th>Écart</th><th>Reste prévu</th></tr></thead><tbody>' + rows + '</tbody><tfoot><tr><td>Total</td><td>' + f(tPl) + '</td><td>' + (tN ? f(tReal) : '—') + '</td><td>' + (tN ? '<span class="' + gcls(tGap) + '">' + sg(tGap) + '</span>' : '—') + '</td><td class="' + (tRest < 0 ? 'neg' : '') + '">' + f(tRest) + '</td></tr></tfoot></table></div></section>';
  return h;
}

/* ---------- rendu : on préserve la saisie en cours (temps réel) ---------- */
function captureInputs() {
  const st = { forms: {}, real: null, focus: null };
  document.querySelectorAll('#view form[data-add]').forEach(fm => {
    const o = {};
    ['name', 'amount', 'cat'].forEach(n => { const el = fm.elements[n]; if (el) o[n] = el.value; });
    st.forms[fm.getAttribute('data-add')] = o;
  });
  const ae = document.activeElement;
  if (ae && ae.dataset && ae.dataset.real) { st.real = { id: ae.dataset.real, value: ae.value }; st.focus = { real: ae.dataset.real }; }
  else if (ae && ae.form && ae.form.getAttribute && ae.form.getAttribute('data-add') && ae.name)
    st.focus = { add: ae.form.getAttribute('data-add'), name: ae.name };
  return st;
}
function restoreInputs(st) {
  Object.keys(st.forms).forEach(k => {
    const fm = document.querySelector('#view form[data-add="' + k + '"]');
    if (!fm) return;
    Object.keys(st.forms[k]).forEach(n => { const el = fm.elements[n]; if (el) el.value = st.forms[k][n]; });
  });
  if (st.real) { const el = document.querySelector('#view [data-real="' + st.real.id + '"]'); if (el) el.value = st.real.value; }
  if (st.focus) {
    let el = null;
    if (st.focus.real) el = document.querySelector('#view [data-real="' + st.focus.real + '"]');
    else { const fm = document.querySelector('#view form[data-add="' + st.focus.add + '"]'); el = fm && fm.elements[st.focus.name]; }
    if (el) { try { el.focus(); } catch (e) {} }
  }
}
function render() {
  const st = captureInputs();
  renderSum();
  $('#sum').style.display = tab === 'year' ? 'none' : '';
  $('#prev').parentNode.style.display = tab === 'year' ? 'none' : '';
  $('#t-fixes').setAttribute('aria-selected', tab === 'fixes');
  $('#t-plans').setAttribute('aria-selected', tab === 'plans');
  $('#t-year').setAttribute('aria-selected', tab === 'year');
  const v = $('#view');
  v.className = 'tab-' + tab;
  v.innerHTML = tab === 'fixes'
    ? listBlock('Revenus', 'income', 'Ex. Salaire', 'Ce qui rentre chaque mois.') + listBlock('Frais', 'fixed', 'Ex. Loyer', 'Ce qui sort chaque mois : loyer, abonnements, assurances…')
    : tab === 'plans' ? renderPlans() : renderYear();
  restoreInputs(st);
}

/* ---------- événements du budget ---------- */
$('#prev').onclick = () => shift(-1);
$('#next').onclick = () => shift(1);
$('#t-fixes').onclick = () => { tab = 'fixes'; render(); };
$('#t-plans').onclick = () => { tab = 'plans'; render(); };
$('#t-year').onclick = () => { tab = 'year'; yr = +ym.slice(0, 4); render(); };

const view = $('#view');
view.addEventListener('click', e => {
  let b = e.target.closest('[data-yr]');
  if (b) { yr += +b.getAttribute('data-yr'); render(); return; }
  b = e.target.closest('[data-preset]');
  if (b) { const p = b.getAttribute('data-preset').split('-'); pFrom = +p[0]; pTo = +p[1]; render(); }
});
view.addEventListener('change', e => {
  const s = e.target.getAttribute && e.target.getAttribute('data-sel');
  if (s) {
    const v = +e.target.value;
    if (s === 'from') { pFrom = v; if (pTo < v) pTo = v; } else { pTo = v; if (pFrom > v) pFrom = v; }
    render(); return;
  }
  const id = e.target.getAttribute && e.target.getAttribute('data-real');
  if (id) {
    if (!store.canWrite) return;
    const v = e.target.value === '' ? '' : parseFloat(e.target.value);
    if (v !== '' && isNaN(v)) return;
    plans().forEach(x => { if (x.id === id) x.real = v; });
    render();
    write(() => store.updateItem('plans', id, { real: v }));   // écriture ciblée : un seul champ
  }
});
view.addEventListener('submit', e => {
  e.preventDefault();
  if (!store.canWrite) return toast('Lecture seule : ajout impossible');
  const fm = e.target, k = fm.getAttribute('data-add');
  const n = fm.elements.name.value.trim(), a = parseFloat(fm.elements.amount.value);
  if (!n || isNaN(a) || a < 0) return;
  const id = uid(), ts = Date.now();
  fm.elements.name.value = ''; fm.elements.amount.value = '';
  if (k === 'plan') {
    const cat = fm.elements.cat.value;
    plans().push({ id, name: n, cat, amount: a, real: '', month: ym, ts });
    render();
    write(() => store.addItem('plans', id, { name: n, cat, amount: a, real: '', month: ym, ts }));
  } else {
    data[k].push({ id, name: n, amount: a, ts });
    render();
    write(() => store.addItem(k, id, { name: n, amount: a, ts }));
  }
});
view.addEventListener('click', e => {
  const b = e.target.closest('[data-del]');
  if (b) {
    if (!store.canWrite) return toast('Lecture seule : suppression impossible');
    const k = b.getAttribute('data-del'), id = b.getAttribute('data-id');
    if (k === 'plan') {
      const arr = plans(), i = arr.findIndex(x => x.id === id);
      if (i < 0) return;
      const item = arr[i]; arr.splice(i, 1); render();
      write(() => store.deleteItem('plans', id));
      toastUndo('Dépense supprimée', () => {
        (data.plans[item.month] || (data.plans[item.month] = [])).push(item);
        render();
        write(() => store.addItem('plans', item.id, planPayload(item)));
      });
    } else {
      const arr = data[k], i = arr.findIndex(x => x.id === id);
      if (i < 0) return;
      const item = arr[i]; arr.splice(i, 1); render();
      write(() => store.deleteItem(k, id));
      toastUndo('Ligne supprimée', () => {
        data[k].push(item); render();
        write(() => store.addItem(k, item.id, { name: item.name, amount: item.amount, ts: item.ts || Date.now() }));
      });
    }
    return;
  }
  if (e.target.id === 'copy') {
    if (!store.canWrite) return toast('Lecture seule : action impossible');
    const p = ym.split('-'), d = new Date(+p[0], +p[1] - 2, 1), pk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const src = data.plans[pk] || [];
    if (!src.length) { alert('Aucune dépense prévue le mois précédent.'); return; }
    const jobs = [];
    src.forEach((x, i) => {
      const id = uid(), ts = Date.now() + i;
      plans().push({ id, name: x.name, cat: x.cat, amount: x.amount, real: '', month: ym, ts });
      jobs.push(() => store.addItem('plans', id, { name: x.name, cat: x.cat, amount: x.amount, real: '', month: ym, ts }));
    });
    render();
    write(async () => { for (const j of jobs) await j(); });
  }
});

/* ---------- comptes liés + accès accordés ---------- */
function applyViewMode() {
  const link = store.currentLink;
  document.body.classList.toggle('readonly-mode', !!link && link.permissions === 'read');
  const banner = $('#readonly-banner');
  if (link) {
    banner.hidden = false;
    banner.classList.toggle('write-mode', link.permissions === 'write');
    $('#readonly-icon').textContent = link.permissions === 'write' ? '✏️' : '🔒';
    $('#readonly-text').textContent = link.permissions === 'write' ? 'Vous modifiez le compte de' : 'Lecture seule — compte de';
    $('#readonly-email').textContent = link.ownerEmail;
  } else banner.hidden = true;
  $('#current-account-label').textContent = store.isSelf ? 'Mon compte' : store.currentView;
  document.querySelectorAll('#account-menu [data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view === store.currentView));
}

function renderAccountMenu() {
  const list = $('#linked-accounts-list');
  list.innerHTML = !store.linkedAccounts.length
    ? '<p class="menu-empty">Aucun compte lié pour le moment.</p>'
    : store.linkedAccounts.map(l => `
      <div class="account-row ${store.currentView === l.ownerEmail ? 'active' : ''}">
        <button class="account-option" data-view="${esc(l.ownerEmail)}" type="button">
          <span class="account-icon">👥</span>
          <span class="mail">${esc(l.ownerEmail)}</span>
          <span class="account-permission">${l.permissions === 'read' ? '👁️ lecture' : '✏️ écriture'}</span>
        </button>
        <button class="unlink-btn" data-unlink="${l.id}" title="Rompre le lien" type="button">✕</button>
      </div>`).join('');

  const block = $('#shared-with-block');
  block.hidden = !store.isSelf;
  if (!store.isSelf) return;
  const rows = [];
  store.sharedWith.forEach(l => rows.push(`
    <div class="account-row">
      <span class="account-option static">
        <span class="account-icon">👥</span>
        <span class="mail">${esc(l.linkedEmail)}</span>
        <span class="account-permission">${l.permissions === 'read' ? '👁️ lecture' : '✏️ écriture'}</span>
      </span>
      <button class="unlink-btn" data-revoke="${l.id}" title="Révoquer l'accès" type="button">✕</button>
    </div>`));
  store.pendingSent.forEach(i => rows.push(`
    <div class="account-row">
      <span class="account-option static">
        <span class="account-icon">✉️</span>
        <span class="mail">${esc(i.toEmail)}</span>
        <span class="account-permission">en attente</span>
      </span>
      <button class="unlink-btn" data-cancel="${i.id}" title="Annuler l'invitation" type="button">✕</button>
    </div>`));
  $('#shared-with-list').innerHTML = rows.length ? rows.join('') : '<p class="menu-empty">Personne n’a accès à votre budget.</p>';
}

function openAccountMenu() {
  renderAccountMenu(); applyViewMode();
  $('#account-menu').hidden = false;
  $('#account-btn').classList.add('open');
  checkPendingInvitations();
  store.loadSharedWith().then(renderAccountMenu).catch(err => console.warn(err));
}
function closeAccountMenu() { $('#account-menu').hidden = true; $('#account-btn').classList.remove('open'); }

$('#account-btn').addEventListener('click', e => {
  e.stopPropagation();
  $('#account-menu').hidden ? openAccountMenu() : closeAccountMenu();
});
document.addEventListener('click', e => { if (!e.target.closest('.account-switcher')) closeAccountMenu(); });

$('#account-menu').addEventListener('click', async e => {
  const revoke = e.target.closest('[data-revoke]');
  if (revoke) {
    e.stopPropagation();
    if (!confirm("Révoquer l'accès de cette personne ?")) return;
    try { await store.removeLink(revoke.dataset.revoke); renderAccountMenu(); toast('Accès révoqué'); }
    catch (err) { toast(frErr(err)); }
    return;
  }
  const cancel = e.target.closest('[data-cancel]');
  if (cancel) {
    e.stopPropagation();
    try { await store.cancelInvitation(cancel.dataset.cancel); renderAccountMenu(); toast('Invitation annulée'); }
    catch (err) { toast(frErr(err)); }
    return;
  }
  const unlink = e.target.closest('[data-unlink]');
  if (unlink) {
    e.stopPropagation();
    if (confirm('Rompre le lien avec ce compte ?')) {
      await store.removeLink(unlink.dataset.unlink);
      applyViewMode(); renderAccountMenu(); store.openData();
      toast('Lien supprimé');
    }
    return;
  }
  const opt = e.target.closest('[data-view]');
  if (opt) {
    store.currentView = opt.dataset.view;
    closeAccountMenu(); applyViewMode();
    store.openData().catch(err => toast(frErr(err)));
  }
});

/* ---------- invitation ---------- */
$('#invite-btn').addEventListener('click', () => {
  closeAccountMenu();
  $('#invite-email').value = '';
  $('#invite-error').hidden = true;
  $('#modal-invite').hidden = false;
});
$('#invite-cancel').addEventListener('click', () => $('#modal-invite').hidden = true);
$('#modal-invite').addEventListener('click', e => { if (e.target.id === 'modal-invite') $('#modal-invite').hidden = true; });
$('#invite-send').addEventListener('click', async () => {
  const email = $('#invite-email').value.trim(), permissions = $('#invite-permissions').value;
  const err = $('#invite-error');
  if (!email || !email.includes('@')) { err.textContent = "Veuillez entrer une adresse e-mail valide."; err.hidden = false; return; }
  try {
    await store.sendInvitation(email, permissions);
    toast(`Invitation envoyée à ${email} ✦`);
    $('#modal-invite').hidden = true;
    renderAccountMenu();
  } catch (e) { err.textContent = frErr(e); err.hidden = false; }
});

/* ---------- invitations reçues ---------- */
async function checkPendingInvitations() {
  try {
    const pending = await store.getPendingInvitations();
    if (pending.length) showPendingInvitations(pending);
  } catch (err) { console.error('Vérification des invitations :', err); }
}
function showPendingInvitations(invitations) {
  const list = $('#pending-list');
  list.innerHTML = invitations.map(inv => `
    <div class="pending-item">
      <div>
        <div class="pending-email">${esc(inv.fromEmail)}</div>
        <div class="pending-permission">${inv.permissions === 'read' ? '👁️ Lecture seule' : '✏️ Lecture et écriture'}</div>
      </div>
      <div class="pending-actions">
        <button data-id="${esc(inv.id)}" data-action="accept">Accepter</button>
        <button class="btn-refuse" data-id="${esc(inv.id)}" data-action="refuse">Refuser</button>
      </div>
    </div>`).join('');
  $('#modal-pending').hidden = false;
  list.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const inv = invitations.find(i => i.id === btn.dataset.id);
      try {
        await store.respondToInvitation(inv, btn.dataset.action === 'accept');
        toast(btn.dataset.action === 'accept' ? 'Invitation acceptée ✦' : 'Invitation refusée');
        btn.closest('.pending-item').remove();
        if (!list.querySelector('.pending-item')) $('#modal-pending').hidden = true;
        renderAccountMenu(); applyViewMode();
      } catch (err) { toast(frErr(err)); }
    });
  });
}
$('#pending-close').addEventListener('click', () => $('#modal-pending').hidden = true);
$('#modal-pending').addEventListener('click', e => { if (e.target.id === 'modal-pending') $('#modal-pending').hidden = true; });

/* ---------- authentification ---------- */
let authMode = 'login';
document.querySelectorAll('.auth-tabs button').forEach(b => b.addEventListener('click', () => {
  authMode = b.dataset.mode;
  document.querySelectorAll('.auth-tabs button').forEach(x => x.classList.toggle('on', x === b));
  $('#auth-submit').textContent = authMode === 'login' ? 'Se connecter' : 'Créer mon compte';
  $('#auth-pass').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').hidden = true;
  $('#forgot-btn').hidden = authMode !== 'login';
}));

$('#auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#auth-email').value.trim(), pass = $('#auth-pass').value;
  const btn = $('#auth-submit'), el = $('#auth-error');
  btn.disabled = true; btn.textContent = 'Un instant…';
  try {
    if (authMode === 'login') await store.login(email, pass);
    else { await store.register(email, pass); if (USE_FIREBASE) toast('E-mail de vérification envoyé ✦'); }
    await loadAndEnter();
    checkPendingInvitations();
  } catch (err) {
    el.className = 'error'; el.textContent = frErr(err); el.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = authMode === 'login' ? 'Se connecter' : 'Créer mon compte';
  }
});

$('#forgot-btn').addEventListener('click', async () => {
  const email = $('#auth-email').value.trim(), el = $('#auth-error');
  el.hidden = false;
  if (!email) { el.className = 'error'; el.textContent = 'Saisissez votre e-mail ci-dessus, puis cliquez à nouveau.'; return; }
  try {
    await store.resetPassword(email);
    el.className = 'error ok';
    el.textContent = 'E-mail de réinitialisation envoyé à ' + email + ' (pensez aux spams).';
  } catch (err) { el.className = 'error'; el.textContent = frErr(err); }
});

function updateVerifyBanner() {
  const b = $('#verify-banner');
  b.hidden = store.verified || !store.user;
  if (!b.hidden) $('#verify-email').textContent = store.email;
}
$('#verify-resend').addEventListener('click', async () => {
  try { await store.resendVerification(); toast('Lien de vérification renvoyé ✦'); }
  catch (err) { toast(frErr(err)); }
});
$('#verify-done').addEventListener('click', async () => {
  try {
    await store.refreshVerification();
    updateVerifyBanner();
    toast(store.verified ? 'E-mail vérifié ✦' : "Pas encore vérifié : cliquez le lien reçu par e-mail.");
  } catch (err) { toast(frErr(err)); }
});

$('#logout-btn').addEventListener('click', async () => {
  await store.logout();
  data = { income: [], fixed: [], plans: {} };
  tab = 'fixes';
  $('#view-app').hidden = true;
  $('#view-auth').hidden = false;
  $('#auth-form').reset();
  document.body.classList.remove('readonly-mode');
  $('#readonly-banner').hidden = true;
  $('#verify-banner').hidden = true;
});

/* ---------- cycle de vie ---------- */
async function loadAndEnter() {
  $('#user-chip').textContent = store.user.email || '';
  $('#demo-banner').hidden = USE_FIREBASE;
  updateVerifyBanner();
  $('#view-auth').hidden = true;
  $('#view-app').hidden = false;
  applyViewMode();
  renderAccountMenu();
  try { await store.openData(); } catch (err) { console.error(err); toast(frErr(err)); }
  store.loadSharedWith().then(renderAccountMenu).catch(() => {});
}

/* ---------- PWA ---------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; $('#install-btn').hidden = false; });
$('#install-btn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') { $('#install-btn').hidden = true; deferredPrompt = null; }
});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

/* ---------- toast + annulation ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2600);
}
function toastUndo(msg, onUndo) {
  const t = $('#toast');
  t.innerHTML = '<span>' + esc(msg) + '</span> <button type="button" class="toast-btn" id="toast-undo">Annuler</button>';
  t.hidden = false; t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
  $('#toast-undo').addEventListener('click', () => { clearTimeout(toastTimer); t.hidden = true; onUndo(); });
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 5000);
}

/* ---------- démarrage ---------- */
(async function boot() {
  if (!USE_FIREBASE) $('#demo-hint').hidden = false;
  const u = await store.init();
  if (u) { loadAndEnter(); checkPendingInvitations(); }
})();
