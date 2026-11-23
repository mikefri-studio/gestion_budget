/* ═══════════ Mon budget mensuel — logique applicative ═══════════
   Interface et calculs : code du collègue (revenus / frais fixes / dépenses prévues / bilan).
   Conservé du repo : Firebase (connexion, invitations, comptes liés, permissions) + catégories. */
import { FIREBASE_CONFIG } from './firebase-config.js';

/* ---------- petits outils ---------- */
const $ = s => document.querySelector(s);
const eur = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const fc0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const f = n => eur.format(n || 0);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sum = (a, k) => a.reduce((t, x) => t + (+x[k] || 0), 0);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ---------- catégories (conservées du repo) ---------- */
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

/* ---------- Firebase (chargé uniquement si configuré) ---------- */
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

/* ---------- couche données (Firebase ou local) + comptes liés ---------- */
const store = {
  user: null, currentView: 'self', linkedAccounts: [], _uids: {},
  async init() {
    if (USE_FIREBASE) {
      return new Promise(res => F.authM.onAuthStateChanged(F.auth, async u => {
        this.user = u;
        if (u) { await this.ensureProfile(); await this.loadLinkedAccounts(); }
        res(u);
      }));
    }
    const s = localStorage.getItem('solde.session');
    this.user = s ? { email: s } : null;
    if (this.user) await this.loadLinkedAccounts();
    return this.user;
  },
  async register(email, pass) {
    if (USE_FIREBASE) {
      await F.authM.createUserWithEmailAndPassword(F.auth, email, pass);
      this.user = F.auth.currentUser;
      await this.ensureProfile();
    } else {
      if (pass.length < 6) throw new Error("Mot de passe : 6 caractères minimum.");
      const users = JSON.parse(localStorage.getItem('solde.users') || '{}');
      if (users[email]) throw new Error("Un compte existe déjà avec cet e-mail.");
      users[email] = { pass: btoa(pass) };
      localStorage.setItem('solde.users', JSON.stringify(users));
      localStorage.setItem('solde.session', email);
      this.user = { email };
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
      this.user = { email };
    }
    await this.loadLinkedAccounts();
  },
  async logout() {
    if (USE_FIREBASE) await F.authM.signOut(F.auth);
    else localStorage.removeItem('solde.session');
    this.user = null; this.linkedAccounts = []; this.currentView = 'self';
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
      await setDoc(doc(F.db, 'profiles', this.uid), { email: this.email }, { merge: true });
    } catch (e) { console.warn('Profil non publié :', e); }
  },
  async resolveUid(email) {
    if (!USE_FIREBASE) return email;
    if (this._uids[email]) return this._uids[email];
    const { collection, query, where, getDocs } = F.fsM;
    const snap = await getDocs(query(collection(F.db, 'profiles'), where('email', '==', email)));
    if (snap.empty) throw new Error("Compte introuvable : la personne doit se connecter au moins une fois.");
    this._uids[email] = snap.docs[0].id;
    return this._uids[email];
  },

  /* ========== INVITATIONS ========== */
  async sendInvitation(toEmail, permissions) {
    if (toEmail.toLowerCase() === this.email.toLowerCase()) throw new Error("Vous ne pouvez pas vous inviter vous-même.");
    if (USE_FIREBASE) {
      const { collection, addDoc, query, where, getDocs } = F.fsM;
      const q = query(collection(F.db, 'invitations'),
        where('fromEmail', '==', this.email), where('toEmail', '==', toEmail), where('status', '==', 'pending'));
      const ex = await getDocs(q);
      if (!ex.empty) throw new Error("Une invitation est déjà en attente pour cet e-mail.");
      await addDoc(collection(F.db, 'invitations'), {
        fromEmail: this.email, toEmail, permissions, status: 'pending', timestamp: Date.now()
      });
    } else {
      const inv = JSON.parse(localStorage.getItem('solde.invitations') || '[]');
      if (inv.some(i => i.fromEmail === this.email && i.toEmail === toEmail && i.status === 'pending'))
        throw new Error("Une invitation est déjà en attente pour cet e-mail.");
      inv.push({ id: crypto.randomUUID(), fromEmail: this.email, toEmail, permissions, status: 'pending', timestamp: Date.now() });
      localStorage.setItem('solde.invitations', JSON.stringify(inv));
    }
  },
  async getPendingInvitations() {
    if (USE_FIREBASE) {
      const { collection, query, where, getDocs } = F.fsM;
      const snap = await getDocs(query(collection(F.db, 'invitations'),
        where('toEmail', '==', this.email), where('status', '==', 'pending')));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    const inv = JSON.parse(localStorage.getItem('solde.invitations') || '[]');
    return inv.filter(i => i.toEmail === this.email && i.status === 'pending');
  },
  async respondToInvitation(id, accept) {
    if (USE_FIREBASE) {
      const { doc, getDoc, updateDoc, setDoc } = F.fsM;
      const ref = doc(F.db, 'invitations', id);
      const snap = await getDoc(ref);
      if (!snap.exists()) throw new Error("Invitation introuvable.");
      const inv = snap.data();
      if (accept) {
        const ownerUid = await this.resolveUid(inv.fromEmail);
        await setDoc(doc(F.db, 'linkedAccounts', `${ownerUid}__${this.uid}`), {
          ownerUid, linkedUid: this.uid,
          ownerEmail: inv.fromEmail, linkedEmail: this.email,
          permissions: inv.permissions, timestamp: Date.now()
        });
      }
      await updateDoc(ref, { status: accept ? 'accepted' : 'refused' });
    } else {
      const inv = JSON.parse(localStorage.getItem('solde.invitations') || '[]');
      const item = inv.find(i => i.id === id);
      if (!item) throw new Error("Invitation introuvable.");
      item.status = accept ? 'accepted' : 'refused';
      localStorage.setItem('solde.invitations', JSON.stringify(inv));
      if (accept) {
        const linked = JSON.parse(localStorage.getItem('solde.linked') || '[]');
        linked.push({
          id: `${item.fromEmail}__${this.email}`,
          ownerEmail: item.fromEmail, linkedEmail: this.email, ownerUid: item.fromEmail,
          permissions: item.permissions, timestamp: Date.now()
        });
        localStorage.setItem('solde.linked', JSON.stringify(linked));
      }
    }
    await this.loadLinkedAccounts();
  },
  async loadLinkedAccounts() {
    if (USE_FIREBASE) {
      const { collection, query, where, getDocs } = F.fsM;
      const snap = await getDocs(query(collection(F.db, 'linkedAccounts'), where('linkedUid', '==', this.uid)));
      this.linkedAccounts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } else {
      const linked = JSON.parse(localStorage.getItem('solde.linked') || '[]');
      this.linkedAccounts = linked.filter(l => l.linkedEmail === this.email);
    }
  },
  async removeLink(linkId) {
    if (USE_FIREBASE) {
      const { doc, deleteDoc } = F.fsM;
      await deleteDoc(doc(F.db, 'linkedAccounts', linkId));
    } else {
      const linked = JSON.parse(localStorage.getItem('solde.linked') || '[]');
      localStorage.setItem('solde.linked', JSON.stringify(linked.filter(l => l.id !== linkId)));
    }
    const gone = this.linkedAccounts.find(l => l.id === linkId);
    if (gone && gone.ownerEmail === this.currentView) this.currentView = 'self';
    await this.loadLinkedAccounts();
  },

  /* ========== DONNÉES DU BUDGET (modèle du collègue : income / fixed / plans) ========== */
  async loadData() {
    if (USE_FIREBASE) {
      const { doc, getDoc } = F.fsM;
      const targetUid = this.isSelf ? this.uid : await this.resolveUid(this.currentView);
      const snap = await getDoc(doc(F.db, 'users', targetUid, 'meta', 'budget'));
      const d = snap.exists() ? snap.data() : {};
      return { income: d.income || [], fixed: d.fixed || [], plans: d.plans || {} };
    }
    const d = JSON.parse(localStorage.getItem('budget.data.' + this.viewEmail) || 'null') || {};
    return { income: d.income || [], fixed: d.fixed || [], plans: d.plans || {} };
  },
  async saveData(data) {
    if (!this.canWrite) throw new Error("Mode lecture seule : modification interdite.");
    if (USE_FIREBASE) {
      const { doc, setDoc } = F.fsM;
      const targetUid = this.isSelf ? this.uid : await this.resolveUid(this.currentView);
      await setDoc(doc(F.db, 'users', targetUid, 'meta', 'budget'),
        { income: data.income, fixed: data.fixed, plans: data.plans });
    } else {
      localStorage.setItem('budget.data.' + this.viewEmail, JSON.stringify(data));
    }
  },
};

/* ---------- état du budget (code du collègue, stocké via Firebase) ---------- */
const now0 = new Date();
let data = { income: [], fixed: [], plans: {} };
let ym = `${now0.getFullYear()}-${String(now0.getMonth() + 1).padStart(2, '0')}`;
let tab = 'fixes';
const plans = () => data.plans[ym] || (data.plans[ym] = []);
function shift(d) { const p = ym.split('-'); const dt = new Date(+p[0], +p[1] - 1 + d, 1); ym = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0'); render(); }
function mname() { const p = ym.split('-'); return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }); }

/* Sauvegarde différée (regroupe les frappes rapides) */
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await store.saveData(data); }
    catch (err) { console.error(err); toast(err.message || 'Enregistrement impossible — vérifiez votre connexion.'); }
  }, 350);
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

/* ---------- dépenses prévues (catégories du repo) ---------- */
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

/* ---------- rendu général ---------- */
function render() {
  renderSum();
  $('#sum').style.display = tab === 'year' ? 'none' : '';
  $('#prev').parentNode.style.display = tab === 'year' ? 'none' : '';
  $('#t-fixes').setAttribute('aria-selected', tab === 'fixes');
  $('#t-plans').setAttribute('aria-selected', tab === 'plans');
  $('#t-year').setAttribute('aria-selected', tab === 'year');
  const v = $('#view');
  v.className = 'tab-' + tab; // mise en page responsive par onglet
  v.innerHTML = tab === 'fixes'
    ? listBlock('Revenus', 'income', 'Ex. Salaire', 'Ce qui rentre chaque mois.') + listBlock('Frais', 'fixed', 'Ex. Loyer', 'Ce qui sort chaque mois : loyer, abonnements, assurances…')
    : tab === 'plans' ? renderPlans() : renderYear();
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
    plans().forEach(x => { if (x.id === id) x.real = e.target.value === '' ? '' : parseFloat(e.target.value); });
    persist(); render();
  }
});
view.addEventListener('submit', e => {
  e.preventDefault();
  if (!store.canWrite) return toast('Lecture seule : ajout impossible');
  const fm = e.target, k = fm.getAttribute('data-add');
  const n = fm.elements.name.value.trim(), a = parseFloat(fm.elements.amount.value);
  if (!n || isNaN(a) || a < 0) return;
  if (k === 'plan') plans().push({ id: uid(), name: n, cat: fm.elements.cat.value, amount: a, real: '' });
  else data[k].push({ id: uid(), name: n, amount: a });
  persist(); render();
});
view.addEventListener('click', e => {
  const b = e.target.closest('[data-del]');
  if (b) {
    if (!store.canWrite) return toast('Lecture seule : suppression impossible');
    const k = b.getAttribute('data-del'), id = b.getAttribute('data-id');
    if (k === 'plan') data.plans[ym] = plans().filter(x => x.id !== id);
    else data[k] = data[k].filter(x => x.id !== id);
    persist(); render(); return;
  }
  if (e.target.id === 'copy') {
    if (!store.canWrite) return toast('Lecture seule : action impossible');
    const p = ym.split('-'), d = new Date(+p[0], +p[1] - 2, 1), pk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const src = data.plans[pk] || [];
    if (!src.length) { alert('Aucune dépense prévue le mois précédent.'); return; }
    src.forEach(x => { plans().push({ id: uid(), name: x.name, cat: x.cat, amount: x.amount, real: '' }); });
    persist(); render();
  }
});

/* ---------- COMPTES LIÉS : interface (conservée du repo) ---------- */
function applyViewMode() {
  const link = store.currentLink;
  const readonly = !!link && link.permissions === 'read';
  document.body.classList.toggle('readonly-mode', readonly);
  const banner = $('#readonly-banner');
  if (link) {
    banner.hidden = false;
    banner.classList.toggle('write-mode', link.permissions === 'write');
    $('#readonly-icon').textContent = link.permissions === 'write' ? '✏️' : '🔒';
    $('#readonly-text').textContent = link.permissions === 'write' ? 'Vous modifiez le compte de' : 'Lecture seule — compte de';
    $('#readonly-email').textContent = link.ownerEmail;
  } else {
    banner.hidden = true;
  }
  $('#current-account-label').textContent = store.isSelf ? 'Mon compte' : store.currentView;
  document.querySelectorAll('#account-menu [data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view === store.currentView));
}
function renderAccountMenu() {
  const list = $('#linked-accounts-list');
  if (!store.linkedAccounts.length) {
    list.innerHTML = '<p class="menu-empty">Aucun compte lié pour le moment.</p>';
    return;
  }
  list.innerHTML = store.linkedAccounts.map(l => `
    <div class="account-row ${store.currentView === l.ownerEmail ? 'active' : ''}">
      <button class="account-option" data-view="${esc(l.ownerEmail)}" type="button">
        <span class="account-icon">👥</span>
        <span class="mail">${esc(l.ownerEmail)}</span>
        <span class="account-permission ${l.permissions}">${l.permissions === 'read' ? '👁️ lecture' : '✏️ écriture'}</span>
      </button>
      <button class="unlink-btn" data-unlink="${l.id}" title="Rompre le lien" type="button">✕</button>
    </div>`).join('');
}
function openAccountMenu() {
  renderAccountMenu();
  applyViewMode();
  $('#account-menu').hidden = false;
  $('#account-btn').classList.add('open');
  checkPendingInvitations();
}
function closeAccountMenu() {
  $('#account-menu').hidden = true;
  $('#account-btn').classList.remove('open');
}
$('#account-btn').addEventListener('click', e => {
  e.stopPropagation();
  $('#account-menu').hidden ? openAccountMenu() : closeAccountMenu();
});
document.addEventListener('click', e => {
  if (!e.target.closest('.account-switcher')) closeAccountMenu();
});
$('#account-menu').addEventListener('click', async e => {
  const unlink = e.target.closest('[data-unlink]');
  if (unlink) {
    e.stopPropagation();
    if (confirm('Rompre le lien avec ce compte ?')) {
      await store.removeLink(unlink.dataset.unlink);
      applyViewMode(); renderAccountMenu(); refresh();
      toast('Lien supprimé');
    }
    return;
  }
  const opt = e.target.closest('[data-view]');
  if (opt) {
    store.currentView = opt.dataset.view;
    closeAccountMenu();
    applyViewMode();
    refresh();
  }
});

/* ---------- invitation : envoi ---------- */
$('#invite-btn').addEventListener('click', () => {
  closeAccountMenu();
  $('#invite-email').value = '';
  $('#invite-error').hidden = true;
  $('#modal-invite').hidden = false;
});
$('#invite-cancel').addEventListener('click', () => $('#modal-invite').hidden = true);
$('#modal-invite').addEventListener('click', e => { if (e.target.id === 'modal-invite') $('#modal-invite').hidden = true; });
$('#invite-send').addEventListener('click', async () => {
  const email = $('#invite-email').value.trim();
  const permissions = $('#invite-permissions').value;
  if (!email || !email.includes('@')) {
    $('#invite-error').textContent = "Veuillez entrer une adresse e-mail valide.";
    $('#invite-error').hidden = false;
    return;
  }
  try {
    await store.sendInvitation(email, permissions);
    toast(`Invitation envoyée à ${email} ✦`);
    $('#modal-invite').hidden = true;
  } catch (err) {
    $('#invite-error').textContent = err.message;
    $('#invite-error').hidden = false;
  }
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
        <button data-id="${inv.id}" data-action="accept">Accepter</button>
        <button class="btn-refuse" data-id="${inv.id}" data-action="refuse">Refuser</button>
      </div>
    </div>`).join('');
  $('#modal-pending').hidden = false;
  list.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await store.respondToInvitation(btn.dataset.id, btn.dataset.action === 'accept');
        toast(btn.dataset.action === 'accept' ? 'Invitation acceptée ✦' : 'Invitation refusée');
        btn.closest('.pending-item').remove();
        if (!list.querySelector('.pending-item')) $('#modal-pending').hidden = true;
        renderAccountMenu(); applyViewMode();
      } catch (err) { toast(err.message); }
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
}));
function frAuthError(err) {
  if (!USE_FIREBASE) return err.message || 'Erreur.';
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
  return map[err?.code] || err.message || 'Erreur inconnue.';
}
$('#auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#auth-email').value.trim(), pass = $('#auth-pass').value;
  const btn = $('#auth-submit');
  btn.disabled = true; btn.textContent = 'Un instant…';
  try {
    if (authMode === 'login') await store.login(email, pass);
    else await store.register(email, pass);
    await loadAndEnter();
    checkPendingInvitations();
  } catch (err) {
    const el = $('#auth-error');
    el.textContent = frAuthError(err); el.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = authMode === 'login' ? 'Se connecter' : 'Créer mon compte';
  }
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
});

/* ---------- cycle de vie ---------- */
async function refresh() {
  try {
    const d = await store.loadData();
    data = { income: d.income || [], fixed: d.fixed || [], plans: d.plans || {} };
    render();
  } catch (err) { console.error(err); toast('Impossible de charger vos données (règles Firestore ?).'); }
}
async function loadAndEnter() {
  $('#user-chip').textContent = store.user.email || '';
  $('#demo-banner').hidden = USE_FIREBASE;
  $('#view-auth').hidden = true;
  $('#view-app').hidden = false;
  applyViewMode();
  renderAccountMenu();
  await refresh();
}

/* ---------- installation PWA + service worker ---------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredPrompt = e; $('#install-btn').hidden = false;
});
$('#install-btn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') { $('#install-btn').hidden = true; deferredPrompt = null; }
});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.hidden = true, 2600);
}

/* ---------- démarrage ---------- */
(async function boot() {
  if (!USE_FIREBASE) $('#demo-hint').hidden = false;
  const u = await store.init();
  if (u) {
    loadAndEnter();
    checkPendingInvitations();
  }
})();
