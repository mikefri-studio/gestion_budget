/* ═══════════ Solde — logique applicative (comptes liés + permissions) ═══════════ */
import { FIREBASE_CONFIG } from './firebase-config.js';

/* ---------- petits outils ---------- */
const $ = s => document.querySelector(s);
const eur = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* ---------- catégories ---------- */
const CATS_DEP = [
  { id: 'alimentation',  label: 'Alimentation',  e: '🥐',   c: '#E2B45A' },
  { id: 'logement',      label: 'Logement',      e: '🏠',   c: '#7FB4E6' },
  { id: 'transport',     label: 'Transport',     e: '🚇',   c: '#59D69F' },
  { id: 'loisirs',       label: 'Loisirs',       e: '🎬',   c: '#E98AC2' },
  { id: 'sante',         label: 'Santé',         e: '💊',   c: '#F2705C' },
  { id: 'shopping',      label: 'Shopping',      e: '🛍️',  c: '#C9A6FF' },
  { id: 'abonnements',   label: 'Abonnements',   e: '📺',   c: '#6FD6C7' },
  { id: 'autre',         label: 'Autre',         e: '🧾',   c: '#9DB3A6' },
];
const CATS_REC = [
  { id: 'salaire',    label: 'Salaire',    e: '💼', c: '#59D69F' },
  { id: 'freelance',  label: 'Freelance',  e: '🧑‍💻', c: '#6FD6C7' },
  { id: 'aides',      label: 'Aides',      e: '🤝', c: '#E2B45A' },
  { id: 'autre-rec',  label: 'Autre',      e: '💶', c: '#9DB3A6' },
];
const CAT = Object.fromEntries([...CATS_DEP, ...CATS_REC].map(c => [c.id, c]));
const DEFAULT_BUDGETS = { alimentation: 300, logement: 700, transport: 120, loisirs: 150, sante: 50, shopping: 120, abonnements: 40, autre: 80 };

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
  user: null,
  currentView: 'self',   // 'self' ou e-mail du compte consulté
  linkedAccounts: [],    // [{ id, ownerEmail, ownerUid, permissions }]

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
      if (pass.length < 6) throw new Error('Mot de passe : 6 caractères minimum.');
      const users = JSON.parse(localStorage.getItem('solde.users') || '{}');
      if (users[email]) throw new Error('Un compte existe déjà avec cet e-mail.');
      users[email] = { pass: btoa(pass) }; // ⚠️ démo uniquement — la prod utilise Firebase Auth
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
      if (!users[email] || users[email].pass !== btoa(pass)) throw new Error('E-mail ou mot de passe incorrect.');
      localStorage.setItem('solde.session', email);
      this.user = { email };
    }
    await this.loadLinkedAccounts();
  },

  async logout() {
    if (USE_FIREBASE) await F.authM.signOut(F.auth);
    else localStorage.removeItem('solde.session');
    this.user = null;
    this.linkedAccounts = [];
    this.currentView = 'self';
  },

  get uid() { return USE_FIREBASE ? this.user.uid : 'local'; },
  get email() { return (this.user && this.user.email) || 'local'; },
  get isSelf() { return this.currentView === 'self'; },
  get currentLink() { return this.linkedAccounts.find(l => l.ownerEmail === this.currentView) || null; },
  get canWrite() { return this.isSelf || (this.currentLink ? this.currentLink.permissions === 'write' : false); },
  get viewEmail() { return this.isSelf ? this.email : this.currentView; },

  /* Publie un profil (email ↔ uid) pour permettre la résolution entre comptes */
  async ensureProfile() {
    if (!USE_FIREBASE) return;
    try {
      const { doc, setDoc } = F.fsM;
      await setDoc(doc(F.db, 'profiles', this.uid), { email: this.email }, { merge: true });
    } catch (e) { console.warn('Profil non publié :', e); }
  },

  async resolveUid(email) {
    if (!USE_FIREBASE) return email;
    const { collection, query, where, getDocs } = F.fsM;
    const snap = await getDocs(query(collection(F.db, 'profiles'), where('email', '==', email)));
    if (snap.empty) throw new Error('Compte introuvable : la personne doit se connecter au moins une fois.');
    return snap.docs[0].id;
  },

  /* ========== INVITATIONS ========== */
  async sendInvitation(toEmail, permissions) {
    if (toEmail.toLowerCase() === this.email.toLowerCase()) throw new Error('Vous ne pouvez pas vous inviter vous-même.');
    if (USE_FIREBASE) {
      const { collection, addDoc, query, where, getDocs } = F.fsM;
      const q = query(collection(F.db, 'invitations'),
        where('fromEmail', '==', this.email), where('toEmail', '==', toEmail), where('status', '==', 'pending'));
      const ex = await getDocs(q);
      if (!ex.empty) throw new Error('Une invitation est déjà en attente pour cet e-mail.');
      await addDoc(collection(F.db, 'invitations'), {
        fromEmail: this.email, toEmail, permissions, status: 'pending', timestamp: Date.now()
      });
    } else {
      const inv = JSON.parse(localStorage.getItem('solde.invitations') || '[]');
      if (inv.some(i => i.fromEmail === this.email && i.toEmail === toEmail && i.status === 'pending'))
        throw new Error('Une invitation est déjà en attente pour cet e-mail.');
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
      if (!snap.exists()) throw new Error('Invitation introuvable.');
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
      if (!item) throw new Error('Invitation introuvable.');
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

  /* ========== DONNÉES (compte courant ou compte lié) ========== */
  async loadData() {
    if (USE_FIREBASE) {
      const { collection, getDocs, doc, getDoc } = F.fsM;
      const targetUid = this.isSelf ? this.uid : await this.resolveUid(this.currentView);
      const snap = await getDocs(collection(F.db, 'users', targetUid, 'transactions'));
      const txs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const bSnap = await getDoc(doc(F.db, 'users', targetUid, 'meta', 'budgets'));
      return { txs, budgets: bSnap.exists() ? bSnap.data() : { ...DEFAULT_BUDGETS } };
    }
    const k = this.viewEmail;
    const txs = JSON.parse(localStorage.getItem('solde.tx.' + k) || '[]');
    const budgets = JSON.parse(localStorage.getItem('solde.budgets.' + k) || 'null') || { ...DEFAULT_BUDGETS };
    return { txs, budgets };
  },

  async saveTx(tx) {
    if (!this.canWrite) throw new Error('Mode lecture seule : modification interdite.');
    if (USE_FIREBASE) {
      const { collection, addDoc } = F.fsM;
      const targetUid = this.isSelf ? this.uid : await this.resolveUid(this.currentView);
      await addDoc(collection(F.db, 'users', targetUid, 'transactions'), tx);
    } else {
      const key = 'solde.tx.' + this.viewEmail;
      const t = JSON.parse(localStorage.getItem(key) || '[]');
      t.push({ id: crypto.randomUUID(), ...tx });
      localStorage.setItem(key, JSON.stringify(t));
    }
  },

  async deleteTx(id) {
    if (!this.canWrite) throw new Error('Mode lecture seule : suppression interdite.');
    if (USE_FIREBASE) {
      const { doc, deleteDoc } = F.fsM;
      const targetUid = this.isSelf ? this.uid : await this.resolveUid(this.currentView);
      await deleteDoc(doc(F.db, 'users', targetUid, 'transactions', id));
    } else {
      const key = 'solde.tx.' + this.viewEmail;
      const t = JSON.parse(localStorage.getItem(key) || '[]').filter(x => x.id !== id);
      localStorage.setItem(key, JSON.stringify(t));
    }
  },

  async saveBudgets(b) {
    if (!this.canWrite) throw new Error('Mode lecture seule : modification interdite.');
    if (USE_FIREBASE) {
      const { doc, setDoc } = F.fsM;
      const targetUid = this.isSelf ? this.uid : await this.resolveUid(this.currentView);
      await setDoc(doc(F.db, 'users', targetUid, 'meta', 'budgets'), b);
    } else {
      localStorage.setItem('solde.budgets.' + this.viewEmail, JSON.stringify(b));
    }
  },
};

/* ---------- état ---------- */
const state = {
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  txs: [], budgets: {}, type: 'depense', cat: 'alimentation',
};
const monthKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthTx = () => state.txs.filter(t => t.date.startsWith(monthKey(state.month)));
const spendByCat = () => {
  const m = {};
  for (const t of monthTx()) if (t.type === 'depense') m[t.cat] = (m[t.cat] || 0) + t.amount;
  return m;
};

/* ---------- rendu ---------- */
function renderAll() {
  $('#m-label').textContent = cap(new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(state.month));
  renderHero(); renderTx(); renderBudgets(); renderSplit();
}

function countUp(el, to) {
  const from = parseFloat(el.dataset.v || 0);
  el.dataset.v = to;
  const t0 = performance.now(), dur = 650;
  (function step(t) {
    const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = eur(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step);
  })(t0);
}

function renderHero() {
  const txs = monthTx();
  const inc = txs.filter(t => t.type === 'recette').reduce((s, t) => s + t.amount, 0);
  const out = txs.filter(t => t.type === 'depense').reduce((s, t) => s + t.amount, 0);
  countUp($('#balance'), inc - out);
  $('#balance').classList.toggle('neg', inc - out < 0);
  $('#sum-in').textContent = eur(inc);
  $('#sum-out').textContent = eur(out);

  const totalB = Object.values(state.budgets).reduce((s, v) => s + (v || 0), 0);
  const pct = totalB > 0 ? out / totalB : 0;
  $('#budget-pct').textContent = Math.round(pct * 100) + ' %';
  const bar = $('#budget-bar');
  bar.dataset.w = Math.min(100, pct * 100);
  bar.style.background = pct > 1 ? 'var(--coral)' : 'var(--gold)';

  const C = 2 * Math.PI * 52, ring = $('#gauge-ring');
  ring.style.strokeDasharray = C;
  ring.style.strokeDashoffset = C * (1 - Math.min(1, pct));
  ring.classList.toggle('over', pct > 1);
  const left = totalB - out;
  $('#gauge-txt').textContent = eur(left);
  $('#gauge-sub').textContent = left >= 0 ? 'à dépenser' : 'dépassé';

  const now = new Date();
  const isCurrent = state.month.getFullYear() === now.getFullYear() && state.month.getMonth() === now.getMonth();
  const daysIn = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 0).getDate();
  const elapsed = isCurrent ? now.getDate() : daysIn;
  $('#st-avg').textContent = eur(out / Math.max(1, elapsed));
  const max = txs.filter(t => t.type === 'depense').reduce((m, t) => Math.max(m, t.amount), 0);
  $('#st-max').textContent = max ? eur(max) : '—';
  $('#st-count').textContent = txs.length;
  $('#tx-count').textContent = txs.length + (txs.length > 1 ? ' opérations' : ' opération');

  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll('#budget-bar').forEach(i => i.style.width = i.dataset.w + '%');
  }));
}

function dayLabel(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  const dt = new Date(y, m - 1, d), now = new Date();
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((t0 - dt) / 86400000);
  if (diff === 0) return 'Aujourd'hui';
  if (diff === 1) return 'Hier';
  return cap(new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }).format(dt));
}

function txHTML(t, i) {
  const c = CAT[t.cat] || CAT.autre;
  return `<div class="tx" style="animation-delay:${Math.min(i * 35, 320)}ms">
    <span class="tx-ico" style="--c:${c.c}">${c.e}</span>
    <div class="tx-meta"><b>${c.label}</b>${t.note ? `<small>${esc(t.note)}</small>` : ''}</div>
    <span class="tx-amt ${t.type === 'recette' ? 'in' : ''}">${t.type === 'recette' ? '+' : '−'}${eur(t.amount)}</span>
    ${store.canWrite ? `<button class="tx-del" data-id="${t.id}" aria-label="Supprimer">✕</button>` : '<span></span>'}
  </div>`;
}

function renderTx() {
  const list = monthTx().sort((a, b) => b.date.localeCompare(a.date) || (b.ts || 0) - (a.ts || 0));
  const el = $('#tx-list');
  if (!list.length) {
    el.innerHTML = `<div class="empty">
      <div class="empty-coin">€</div>
      <p>Rien d'inscrit pour ce mois pour l'instant.</p>
      ${store.canWrite ? `<div class="empty-actions">
        <button class="btn-primary" id="empty-add">Ajouter une opération</button>
        <button class="btn-ghost" id="empty-seed">Charger des exemples</button>
      </div>` : ''}</div>`;
    return;
  }
  const groups = {};
  for (const t of list) (groups[t.date] ||= []).push(t);
  el.innerHTML = Object.entries(groups).map(([date, items]) => {
    const net = items.reduce((s, t) => s + (t.type === 'recette' ? t.amount : -t.amount), 0);
    return `<div class="tx-day">
      <p class="tx-day-label"><span>${dayLabel(date)}</span>
      <span class="tx-day-sum ${net < 0 ? 'neg' : 'pos'}">${net < 0 ? '−' : '+'}${eur(Math.abs(net))}</span></p>
      ${items.map((t, i) => txHTML(t, i)).join('')}</div>`;
  }).join('');
}

function renderBudgets() {
  const spent = spendByCat();
  const totalB = Object.values(state.budgets).reduce((s, v) => s + (v || 0), 0);
  const totalS = Object.values(spent).reduce((s, v) => s + v, 0);
  $('#budget-list').innerHTML = CATS_DEP.map(c => {
    const b = state.budgets[c.id] || 0, s = spent[c.id] || 0;
    const pct = b > 0 ? s / b : (s > 0 ? 1 : 0), over = b > 0 && s > b;
    return `<div class="b-row">
      <span class="tx-ico sm" style="--c:${c.c}">${c.e}</span>
      <div><div class="b-top"><b>${c.label}</b>
        <span class="b-nums ${over ? 'over' : ''}">${eur(s)} <em>/ ${eur(b)}</em></span></div>
      <div class="bar"><i style="background:${over ? 'var(--coral)' : c.c}" data-w="${Math.min(100, pct * 100)}"></i></div></div>
    </div>`;
  }).join('') + `<div class="b-total"><span>Budget total</span><b>${eur(totalS)} / ${eur(totalB)}</b></div>`;
  animateBars('#budget-list');
}

function renderSplit() {
  const spent = spendByCat();
  const entries = Object.entries(spent).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (!total) { $('#split-list').innerHTML = '<p class="muted">Aucune dépense ce mois-ci.</p>'; return; }
  $('#split-list').innerHTML = entries.map(([id, v]) => {
    const c = CAT[id] || CAT.autre, share = v / total * 100;
    return `<div class="s-row"><span>${c.e}</span><span>${c.label}</span>
      <div class="bar"><i style="background:${c.c}" data-w="${share}"></i></div>
      <span class="s-val">${eur(v)}</span></div>`;
  }).join('');
  animateBars('#split-list');
}

function animateBars(scope) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll(scope + ' .bar i').forEach(i => i.style.width = i.dataset.w + '%');
  }));
}

/* ---------- formulaire d'ajout ---------- */
function buildCats() {
  const list = state.type === 'depense' ? CATS_DEP : CATS_REC;
  $('#tx-cats').innerHTML = list.map(c =>
    `<button type="button" class="cat-chip ${c.id === state.cat ? 'on' : ''}" data-id="${c.id}" style="--c:${c.c}"><span>${c.e}</span>${c.label}</button>`
  ).join('');
}

$('#tx-seg').addEventListener('click', e => {
  const b = e.target.closest('button[data-type]');
  if (!b) return;
  state.type = b.dataset.type;
  state.cat = (state.type === 'depense' ? CATS_DEP : CATS_REC)[0].id;
  $('#tx-seg').dataset.type = state.type;
  document.querySelectorAll('#tx-seg button').forEach(x => x.classList.toggle('on', x === b));
  buildCats();
});

$('#tx-cats').addEventListener('click', e => {
  const b = e.target.closest('.cat-chip');
  if (!b) return;
  state.cat = b.dataset.id;
  document.querySelectorAll('.cat-chip').forEach(x => x.classList.toggle('on', x === b));
});

$('#tx-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!store.canWrite) return toast('Lecture seule : ajout impossible');
  const amount = parseFloat($('#tx-amount').value.replace(',', '.'));
  if (!amount || amount <= 0) return toast('Montant invalide');
  try {
    await store.saveTx({
      type: state.type, amount: +amount.toFixed(2), cat: state.cat,
      date: $('#tx-date').value || todayISO(),
      note: $('#tx-note').value.trim(), ts: Date.now(),
    });
    await refresh();
    $('#tx-amount').value = ''; $('#tx-note').value = '';
    toast(state.type === 'depense' ? 'Dépense ajoutée ✦' : 'Recette ajoutée ✦');
    if (window.innerWidth <= 980) { $('#add-card').classList.remove('open'); $('#fab').classList.remove('x'); }
  } catch (err) { console.error(err); toast(err.message || 'Ajout impossible — vérifiez votre connexion.'); }
});

/* ---------- transactions : suppression + état vide ---------- */
$('#tx-list').addEventListener('click', async e => {
  const del = e.target.closest('.tx-del');
  if (del) {
    if (!store.canWrite) return toast('Lecture seule : suppression impossible');
    try { await store.deleteTx(del.dataset.id); await refresh(); toast('Opération supprimée'); }
    catch { toast('Suppression impossible.'); }
    return;
  }
  if (e.target.id === 'empty-add') {
    if (window.innerWidth <= 980) { $('#add-card').classList.add('open'); $('#fab').classList.add('x'); }
    $('#tx-amount').focus();
    return;
  }
  if (e.target.id === 'empty-seed') seedSamples();
});

async function seedSamples() {
  if (!store.canWrite) return toast('Lecture seule : action impossible');
  const y = state.month.getFullYear(), m = state.month.getMonth();
  const now = new Date();
  const maxDay = (y === now.getFullYear() && m === now.getMonth()) ? now.getDate() : 28;
  const D = n => `${y}-${String(m + 1).padStart(2, '0')}-${String(Math.min(n, maxDay)).padStart(2, '0')}`;
  const S = [
    ['recette', 1850, 'salaire', 'Salaire', 1],
    ['depense', 680, 'logement', 'Loyer', 2],
    ['depense', 46.3, 'alimentation', 'Courses', 3],
    ['depense', 84.5, 'transport', 'Pass Navigo', 3],
    ['depense', 17.99, 'abonnements', 'Streaming', 5],
    ['depense', 12.4, 'loisirs', 'Ciné', 6],
    ['depense', 23.8, 'alimentation', 'Marché', 8],
    ['depense', 9.9, 'abonnements', 'Musique', 9],
    ['depense', 64.2, 'shopping', 'Veste', 11],
    ['depense', 18.5, 'sante', 'Pharmacie', 12],
    ['recette', 250, 'freelance', 'Mission', 14],
    ['depense', 38.9, 'alimentation', 'Restaurant', 15],
    ['depense', 27, 'loisirs', 'Concert', 18],
    ['depense', 52.6, 'transport', 'Essence', 20],
  ];
  for (const [type, amount, cat, note, day] of S)
    await store.saveTx({ type, amount, cat, note, date: D(day), ts: Date.now() + day });
  await refresh();
  toast('Données d'exemple chargées ✦');
}

/* ---------- budgets : modal ---------- */
$('#edit-budgets').addEventListener('click', () => {
  if (!store.canWrite) return toast('Lecture seule : modification impossible');
  $('#budget-inputs').innerHTML = CATS_DEP.map(c =>
    `<label class="bi"><span class="tx-ico sm" style="--c:${c.c}">${c.e}</span><span>${c.label}</span>
     <input type="number" min="0" step="10" inputmode="numeric" data-id="${c.id}" value="${state.budgets[c.id] || 0}">
     <span class="cur">€</span></label>`).join('');
  $('#modal-budgets').hidden = false;
});
$('#mb-cancel').addEventListener('click', () => $('#modal-budgets').hidden = true);
$('#modal-budgets').addEventListener('click', e => { if (e.target.id === 'modal-budgets') $('#modal-budgets').hidden = true; });
$('#mb-save').addEventListener('click', async () => {
  if (!store.canWrite) return toast('Lecture seule : modification impossible');
  const b = {};
  document.querySelectorAll('#budget-inputs input').forEach(i => b[i.dataset.id] = Math.max(0, +i.value || 0));
  try { await store.saveBudgets(b); state.budgets = b; renderAll(); $('#modal-budgets').hidden = true; toast('Budgets enregistrés ✦'); }
  catch { toast('Enregistrement impossible.'); }
});

/* ---------- navigation par mois ---------- */
const shiftMonth = n => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + n, 1); renderAll(); };
$('#m-prev').addEventListener('click', () => shiftMonth(-1));
$('#m-next').addEventListener('click', () => shiftMonth(1));
$('#m-label').addEventListener('click', () => { state.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1); renderAll(); });

/* ---------- COMPTES LIÉS : interface ---------- */
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
    $('#invite-error').textContent = 'Veuillez entrer une adresse e-mail valide.';
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
        <button class="btn-accept" data-id="${inv.id}" data-action="accept">Accepter</button>
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
  $('#view-app').hidden = true;
  $('#view-auth').hidden = false;
  $('#auth-form').reset();
  document.body.classList.remove('readonly-mode');
  $('#readonly-banner').hidden = true;
});

/* ---------- cycle de vie ---------- */
async function refresh() {
  const d = await store.loadData();
  state.txs = d.txs || [];
  state.budgets = d.budgets || {};
  renderAll();
}

async function loadAndEnter() {
  try { await refresh(); } catch (err) { console.error(err); toast('Impossible de charger vos données (règles Firestore ?).'); }
  $('#user-chip').textContent = store.user.email || '';
  $('#demo-banner').hidden = USE_FIREBASE;
  $('#view-auth').hidden = true;
  $('#view-app').hidden = false;
  $('#tx-date').value = todayISO();
  buildCats();
  applyViewMode();
  renderAccountMenu();
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

/* ---------- FAB (mobile) ---------- */
$('#fab').addEventListener('click', () => {
  if (!store.canWrite) return toast('Lecture seule : ajout impossible');
  $('#add-card').classList.toggle('open');
  $('#fab').classList.toggle('x');
});

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
