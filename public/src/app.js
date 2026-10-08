/* TreeAI — frontend logic.
 * Talks ONLY to: (1) Supabase (auth + storage, using the public anon key) and
 *                (2) our own /api/* routes. The Gemini key never reaches the browser. */
(function () {
  'use strict';

  var BUCKET = 'tree-images';
  var MAX_DIM = 1600;
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return Math.random().toString(36).slice(2, 10); }

  /* ---------------------------------------------------------------- state */
  var sb = null;                // supabase client
  var cfg = null;               // public config
  var session = null;
  var user = null;
  var history = { loaded: false, total: 0, scans: [] };
  var speciesList = [];
  var scan = freshScan();
  var chatHistory = [];
  var chatBusy = false;
  var lastContextPath = null;

  function freshScan() {
    return { state: 'IDLE', busy: false, previewUrl: null, imagePath: null, analysis: null, species: null, saved: false, saving: false };
  }

  /* ---------------------------------------------------------------- toast + modal */
  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 3800);
  }
  var modalOnClose = null;
  function openModal(html, onClose) {
    $('modalBody').innerHTML = html;
    $('modal').classList.add('open');
    $('modal').setAttribute('aria-hidden', 'false');
    modalOnClose = onClose || null;
    $('modalClose').focus();
  }
  function closeModal() {
    $('modal').classList.remove('open');
    $('modal').setAttribute('aria-hidden', 'true');
    $('modalBody').innerHTML = '';
    if (modalOnClose) { var f = modalOnClose; modalOnClose = null; f(); }
  }
  $('modalClose').addEventListener('click', closeModal);
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('modal').classList.contains('open')) closeModal(); });

  /* ---------------------------------------------------------------- theme */
  var themeToggle = $('themeToggle');
  var prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  document.body.setAttribute('data-theme', prefersLight ? 'light' : 'dark');
  themeToggle.addEventListener('click', function () {
    var cur = document.body.getAttribute('data-theme');
    document.body.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
  });

  /* ---------------------------------------------------------------- API helper */
  function ApiError(code, message, status) {
    this.code = code; this.message = message; this.status = status;
  }
  async function currentToken() {
    if (!sb) return null;
    var r = await sb.auth.getSession();
    return r && r.data && r.data.session ? r.data.session.access_token : null;
  }
  async function api(path, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/json' };
    var token = await currentToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    var init = { method: opts.method || 'GET', headers: headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    var res, json = null;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw new ApiError('NETWORK', 'Network problem — please check your internet connection and try again.', 0);
    }
    try { json = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok || !json || json.ok === false) {
      var msg = json && json.error ? json.error : 'Something went wrong. Please try again.';
      if (res.status === 401 && token) { handleExpiredSession(); }
      throw new ApiError(json && json.code ? json.code : 'ERROR', msg, res.status);
    }
    return json;
  }
  function handleExpiredSession() {
    if (sb) sb.auth.signOut();
  }

  /* ---------------------------------------------------------------- tree catalogue (explore) */
  var FALLBACK_TREES = [
    { name: 'Mango', tamil: 'மாமரம்', sci: 'Mangifera indica', cat: 'Fruit', color1: '#6fcf8e', color2: '#2f8f7c', slug: 'mango' },
    { name: 'Neem', tamil: 'வேம்பு', sci: 'Azadirachta indica', cat: 'Medicinal', color1: '#8bd98a', color2: '#3aa39a', slug: 'neem' },
    { name: 'Coconut', tamil: 'தென்னை', sci: 'Cocos nucifera', cat: 'Agricultural', color1: '#e6b45e', color2: '#c98f3a', slug: 'coconut' },
    { name: 'Banyan', tamil: 'ஆலமரம்', sci: 'Ficus benghalensis', cat: 'Native', color1: '#6fcf8e', color2: '#245c46', slug: 'banyan' },
    { name: 'Tamarind', tamil: 'புளியமரம்', sci: 'Tamarindus indica', cat: 'Fruit', color1: '#dd8f80', color2: '#b1604f', slug: 'tamarind' },
    { name: 'Guava', tamil: 'கொய்யா', sci: 'Psidium guajava', cat: 'Fruit', color1: '#a8d8b9', color2: '#3aa39a', slug: 'guava' },
    { name: 'Jackfruit', tamil: 'பலாமரம்', sci: 'Artocarpus heterophyllus', cat: 'Fruit', color1: '#e6b45e', color2: '#8f6a2f', slug: 'jackfruit' },
    { name: 'Drumstick', tamil: 'முருங்கை', sci: 'Moringa oleifera', cat: 'Medicinal', color1: '#8bd98a', color2: '#2f8f6f', slug: 'drumstick' },
    { name: 'Teak', tamil: 'தேக்கு', sci: 'Tectona grandis', cat: 'Forest', color1: '#3aa39a', color2: '#1f5a54', slug: 'teak' },
    { name: 'Peepal', tamil: 'அரசமரம்', sci: 'Ficus religiosa', cat: 'Native', color1: '#6fcf8e', color2: '#2f8f6f', slug: 'peepal' },
    { name: 'Indian Gooseberry (Amla)', tamil: 'நெல்லிமரம்', sci: 'Phyllanthus emblica', cat: 'Medicinal', color1: '#a8d8b9', color2: '#3aa39a', slug: 'amla' },
    { name: 'Casuarina', tamil: 'சவுக்கு', sci: 'Casuarina equisetifolia', cat: 'Forest', color1: '#9bb3a6', color2: '#556e62', slug: 'casuarina' }
  ];
  var CATEGORIES = ['All', 'Native', 'Fruit', 'Medicinal', 'Agricultural', 'Forest'];

  function leafSVG(c1, c2, id) {
    return '<svg viewBox="0 0 40 40" fill="none"><defs><linearGradient id="' + id + '" x1="4" y1="4" x2="36" y2="36">' +
      '<stop stop-color="' + c1 + '"/><stop offset="1" stop-color="' + c2 + '"/></linearGradient></defs>' +
      '<path d="M20 4c-8 3-14 10-14 18 0 8 6.4 14 14 14s14-6 14-14c0-8-6-15-14-18Z" fill="url(#' + id + ')" opacity="0.9"/>' +
      '<path d="M20 34V16" stroke="rgba(10,20,16,.55)" stroke-width="1.4" stroke-linecap="round"/></svg>';
  }
  function bgGrad(c1, c2) { return 'linear-gradient(135deg, ' + c1 + '33, ' + c2 + '22)'; }
  function safeColor(c, d) { return /^#[0-9a-fA-F]{3,8}$/.test(c || '') ? c : d; }

  function normSpecies(s) {
    return {
      id: s.id || null, slug: s.slug || '', name: s.name, tamil: s.tamil_name || s.tamil || '',
      sci: s.scientific_name || s.sci || '', cat: s.category || s.cat || 'Native',
      color1: safeColor(s.color_from || s.color1, '#6fcf8e'), color2: safeColor(s.color_to || s.color2, '#2f8f7c')
    };
  }
  function treeCardHTML(t) {
    var id = 'tc' + uid();
    return '<div class="tree-card" tabindex="0" role="button" data-slug="' + esc(t.slug) + '" data-cat="' + esc(t.cat) + '" data-name="' + esc((t.name + ' ' + t.tamil + ' ' + t.sci).toLowerCase()) + '">' +
      '<div class="tree-visual" style="background:' + bgGrad(t.color1, t.color2) + '">' + leafSVG(t.color1, t.color2, id) + '</div>' +
      '<div class="tree-body"><div class="cat">' + esc(t.cat) + '</div><h4>' + esc(t.name) + '</h4>' +
      '<div class="tamil">' + esc(t.tamil) + '</div><div class="sci">' + esc(t.sci) + '</div></div></div>';
  }
  var exploreGrid = $('exploreGrid');
  var filterRow = $('filterRow');
  function renderSpecies() {
    $('homeExplore').innerHTML = speciesList.slice(0, 4).map(treeCardHTML).join('');
    exploreGrid.innerHTML = speciesList.map(treeCardHTML).join('');
  }
  async function loadSpecies() {
    try {
      var r = await api('/api/species');
      speciesList = (r.species || []).map(normSpecies);
      if (!speciesList.length) speciesList = FALLBACK_TREES.map(normSpecies);
    } catch (e) {
      speciesList = FALLBACK_TREES.map(normSpecies);
    }
    renderSpecies();
  }
  speciesList = FALLBACK_TREES.map(normSpecies);
  renderSpecies();

  CATEGORIES.forEach(function (cat, i) {
    var b = document.createElement('button');
    b.className = 'chip' + (i === 0 ? ' active' : '');
    b.textContent = cat;
    b.addEventListener('click', function () {
      filterRow.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); });
      b.classList.add('active');
      Array.prototype.forEach.call(exploreGrid.children, function (card) {
        card.style.display = (cat === 'All' || card.getAttribute('data-cat') === cat) ? '' : 'none';
      });
    });
    filterRow.appendChild(b);
  });

  $('globalSearch').addEventListener('input', function (e) {
    var q = e.target.value.trim().toLowerCase();
    if (!q) { return; }
    switchView('explore');
    Array.prototype.forEach.call(exploreGrid.children, function (card) {
      card.style.display = card.getAttribute('data-name').indexOf(q) > -1 ? '' : 'none';
    });
    filterRow.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); });
  });

  function onTreeCard(e) {
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    var card = e.target.closest && e.target.closest('.tree-card');
    if (!card) return;
    e.preventDefault();
    openSpeciesModal(card.getAttribute('data-slug'));
  }
  ['homeExplore', 'exploreGrid'].forEach(function (id) {
    $(id).addEventListener('click', onTreeCard);
    $(id).addEventListener('keydown', onTreeCard);
  });

  async function openSpeciesModal(slug) {
    var base = speciesList.filter(function (s) { return s.slug === slug; })[0];
    if (!base) return;
    var head = '<h2>' + esc(base.name) + '</h2><div class="result-name"><div class="tamil">' + esc(base.tamil) + '</div><div class="sci">' + esc(base.sci) + '</div></div>';
    openModal(head + '<p class="sub">Loading details…</p>');
    try {
      var r = await api('/api/tree/' + encodeURIComponent(slug));
      var t = r.tree, html = head;
      html += '<div class="tag-row">' + (t.family ? '<span class="tag">Family: ' + esc(t.family) + '</span>' : '') + '<span class="tag">' + esc(t.category) + '</span></div>';
      if (t.description) html += '<p class="sub">' + esc(t.description) + '</p>';
      if (t.uses) html += '<div class="res-section"><h4>Uses</h4><p class="sub" style="margin-top:0">' + esc(t.uses) + '</p></div>';
      (r.diseases || []).forEach(function (d) {
        html += '<div class="res-section"><h4>' + esc(d.name) + ' <span class="tag" style="vertical-align:middle">' + esc(d.kind) + ' · ' + esc(d.severity) + '</span></h4>' +
          listHTML('Symptoms', d.symptoms) + listHTML('Management', d.management) + '</div>';
      });
      if (!(r.diseases || []).length) html += '<p class="sub">No common problems recorded for this tree yet.</p>';
      html += '<p class="note">General guidance only. Confirm with a local agriculture or forestry expert before treating a tree.</p>';
      html += '<div class="modal-actions"><button class="btn-small primary" id="spScan" type="button">Scan a tree</button></div>';
      if ($('modal').classList.contains('open')) {
        $('modalBody').innerHTML = html;
        $('spScan').addEventListener('click', function () { closeModal(); switchView('scan'); });
      }
    } catch (e) {
      if ($('modal').classList.contains('open')) {
        $('modalBody').innerHTML = head + '<p class="sub">' + esc(e.message) + '</p>';
      }
    }
  }
  function listHTML(title, items) {
    if (!items || !items.length) return '';
    return '<div style="margin-top:10px"><div class="k" style="font-size:.7rem;font-weight:800;color:var(--text-faint);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">' + esc(title) + '</div><ul>' +
      items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul></div>';
  }

  /* ---------------------------------------------------------------- view routing */
  var views = document.querySelectorAll('.view');
  function switchView(name) {
    views.forEach(function (v) { v.classList.toggle('active', v.getAttribute('data-view') === name); });
    document.querySelectorAll('.nav-btn[data-view]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === name);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (name === 'history' && user && !history.loaded) loadHistory();
  }
  document.querySelectorAll('[data-view]').forEach(function (el) {
    el.addEventListener('click', function () {
      var v = el.getAttribute('data-view');
      if (v && el.tagName !== 'SECTION') switchView(v);
    });
  });
  $('goScanBtn').addEventListener('click', function () { switchView('scan'); });
  $('goChatBtn2').addEventListener('click', function () { switchView('chat'); });
  $('historyScanBtn').addEventListener('click', function () { switchView('scan'); });

  function setGreeting() {
    var h = new Date().getHours();
    var t = h < 12 ? 'Good morning' : (h < 17 ? 'Good afternoon' : 'Good evening');
    $('greetTime').textContent = t + ' 🌿';
  }

  /* ---------------------------------------------------------------- auth */
  var loginScreen = $('loginScreen');
  var app = $('app');

  function displayName(u) {
    var n = u && u.user_metadata && (u.user_metadata.name || u.user_metadata.full_name);
    if (n && String(n).trim()) return String(n).trim();
    var local = ((u && u.email) || 'Explorer').split('@')[0].replace(/[._-]+/g, ' ');
    return local.replace(/\b\w/g, function (c) { return c.toUpperCase(); }) || 'Explorer';
  }
  function showApp(u) {
    var name = displayName(u);
    var initial = name.charAt(0).toUpperCase() || 'E';
    $('greetName').textContent = name;
    $('avatarInit').textContent = initial;
    $('profileInit').textContent = initial;
    $('profileName').textContent = name;
    $('profileEmail').textContent = u.email || '';
    setGreeting();
    loginScreen.classList.add('hidden');
    app.classList.add('active');
  }
  function showLogin() {
    app.classList.remove('active');
    loginScreen.classList.remove('hidden');
    switchView('home');
  }
  function resetUserState() {
    history = { loaded: false, total: 0, scans: [] };
    resetScannerUI();
    scan = freshScan();
    chatHistory = [];
    chatContext = null;
    lastContextPath = null;
    renderHistory();
    $('resultPanel').classList.remove('show');
    $('chatBody').innerHTML = '<div class="msg bot">Hi, I\'m TreeAI 🌿 Ask me about a tree, its symptoms, or how to care for it. Scan a tree first and I\'ll use that scan as context.</div>';
  }
  function friendlyAuthError(err) {
    var m = (err && err.message) || '';
    if (/invalid login credentials/i.test(m)) return 'Incorrect email or password.';
    if (/email not confirmed/i.test(m)) return 'Please confirm your email first — check your inbox for the link.';
    if (/already registered|already been registered/i.test(m)) return 'An account with this email already exists. Try signing in.';
    if (/password should be at least|weak password/i.test(m)) return 'Please choose a stronger password (at least 6 characters).';
    if (/rate limit|too many/i.test(m)) return 'Too many attempts. Please wait a minute and try again.';
    if (/network|fetch/i.test(m)) return 'Network problem — please check your connection.';
    return 'Something went wrong. Please try again.';
  }
  function setHint(el, msg, ok) {
    el.textContent = msg || '';
    el.classList.toggle('ok', !!ok);
  }

  $('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var hint = $('loginHint'), btn = $('loginBtn');
    if (!sb) { setHint(hint, 'The app is not configured yet. Please try again later.'); return; }
    var email = $('email').value.trim(), pwd = $('pwd').value;
    if (pwd.length < 6) { setHint(hint, 'Password should be at least 6 characters.'); return; }
    setHint(hint, '');
    btn.classList.add('loading');
    try {
      var r = await sb.auth.signInWithPassword({ email: email, password: pwd });
      if (r.error) throw r.error;
      $('loginForm').reset();
    } catch (err) {
      setHint(hint, friendlyAuthError(err));
    } finally {
      btn.classList.remove('loading');
    }
  });

  $('signupForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var hint = $('signupHint'), btn = e.target.querySelector('.btn-primary');
    if (!sb) { setHint(hint, 'The app is not configured yet. Please try again later.'); return; }
    var name = $('suName').value.trim(), email = $('suEmail').value.trim(), pwd = $('suPwd').value;
    if (pwd.length < 6) { setHint(hint, 'Password should be at least 6 characters.'); return; }
    setHint(hint, '');
    btn.classList.add('loading');
    try {
      var r = await sb.auth.signUp({ email: email, password: pwd, options: { data: { name: name }, emailRedirectTo: window.location.origin } });
      if (r.error) throw r.error;
      if (r.data && r.data.user && Array.isArray(r.data.user.identities) && r.data.user.identities.length === 0) {
        setHint(hint, 'An account with this email already exists. Try signing in.');
      } else if (!r.data.session) {
        $('signupForm').reset();
        $('signUpForm').style.display = 'none';
        $('signInForm').style.display = 'block';
        setHint($('loginHint'), 'Account created! Check your email to confirm it, then sign in.', true);
      } else {
        $('signupForm').reset();
      }
    } catch (err) {
      setHint(hint, friendlyAuthError(err));
    } finally {
      btn.classList.remove('loading');
    }
  });

  $('toSignup').addEventListener('click', function () {
    $('signInForm').style.display = 'none'; $('signUpForm').style.display = 'block';
  });
  $('toSignin').addEventListener('click', function () {
    $('signUpForm').style.display = 'none'; $('signInForm').style.display = 'block';
  });

  $('forgotBtn').addEventListener('click', async function () {
    var hint = $('loginHint'), email = $('email').value.trim();
    if (!sb) { setHint(hint, 'The app is not configured yet.'); return; }
    if (!email) { setHint(hint, 'Enter your email above, then tap "Forgot password?".'); return; }
    try {
      var r = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
      if (r.error) throw r.error;
      setHint(hint, 'If that email has an account, a reset link is on its way.', true);
    } catch (err) {
      setHint(hint, friendlyAuthError(err));
    }
  });

  function showRecoveryModal() {
    openModal(
      '<h2>Choose a new password</h2><p class="sub">Enter a new password for your TreeAI account.</p>' +
      '<form id="recForm"><div class="field"><label for="recPwd">New password</label><input id="recPwd" type="password" minlength="6" required autocomplete="new-password" placeholder="At least 6 characters"/></div>' +
      '<div class="form-hint" id="recHint"></div><div class="modal-actions" style="margin-top:6px"><button class="btn-small primary" type="submit">Update password</button></div></form>'
    );
    $('recForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var pwd = $('recPwd').value;
      if (pwd.length < 6) { setHint($('recHint'), 'Password should be at least 6 characters.'); return; }
      var r = await sb.auth.updateUser({ password: pwd });
      if (r.error) { setHint($('recHint'), friendlyAuthError(r.error)); return; }
      closeModal();
      toast('Password updated', 'ok');
    });
  }

  async function logout() {
    if (sb) await sb.auth.signOut();
  }
  $('logoutBtnRail').addEventListener('click', logout);
  $('logoutBtnProfile').addEventListener('click', logout);

  function onSession(s, event) {
    session = s;
    user = s ? s.user : null;
    if (user) {
      var wasShown = app.classList.contains('active');
      showApp(user);
      if (!wasShown || event === 'SIGNED_IN') {
        setTimeout(function () { loadSpecies(); loadHistory(); }, 0);
      }
    } else {
      resetUserState();
      showLogin();
    }
  }

  async function init() {
    try {
      var r = await fetch('/api/config', { headers: { Accept: 'application/json' } });
      var j = await r.json();
      if (!r.ok || !j.ok) throw new Error('config');
      cfg = j;
      sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
    } catch (e) {
      setHint($('loginHint'), 'The app is not configured yet (missing server settings). Please try again later.');
      return;
    }
    sb.auth.onAuthStateChange(function (event, s) {
      // never await Supabase calls inside this callback — defer instead
      setTimeout(function () {
        if (event === 'PASSWORD_RECOVERY') { onSession(s, event); showRecoveryModal(); return; }
        if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
          onSession(s, event);
        }
      }, 0);
    });
  }

  /* ---------------------------------------------------------------- history */
  function healthColor(h) {
    if (h === 'Healthy') return 'var(--leaf)';
    if (h === 'Minor concerns') return 'var(--amber)';
    if (h === 'Needs attention' || h === 'Unhealthy') return 'var(--rose)';
    return 'var(--text-faint)';
  }
  function sevColor(s) {
    if (s === 'None') return 'var(--leaf)';
    if (s === 'Low') return 'var(--leaf)';
    if (s === 'Moderate') return 'var(--amber)';
    if (s === 'High') return 'var(--rose)';
    return 'var(--text-faint)';
  }
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function historyCardHTML(s) {
    var c = healthColor(s.health_status);
    var thumb = s.image_url
      ? '<img src="' + esc(s.image_url) + '" alt="' + esc(s.tree_name) + '" loading="lazy"/>'
      : leafSVG('#6fcf8e', '#2f8f7c', 'hs' + uid());
    var label = s.disease && !/^(none visible|unknown)$/i.test(s.disease) ? s.disease : s.health_status;
    return '<button type="button" class="scan-card" data-scan="' + esc(s.id) + '">' +
      '<div class="scan-thumb" style="background:' + bgGrad('#6fcf8e', '#2f8f7c') + '">' + thumb + '</div>' +
      '<h4>' + esc(s.tree_name === 'Unknown' ? 'Unidentified tree' : s.tree_name) + '</h4>' +
      '<div class="meta">' + esc(fmtDate(s.created_at)) + (s.tamil_name && s.tamil_name !== 'Unknown' ? ' · ' + esc(s.tamil_name) : '') + '</div>' +
      '<span class="conf-pill" style="background:color-mix(in srgb, ' + c + ' 15%, transparent); color:' + c + ';">' + esc(s.confidence) + '% · ' + esc(label) + '</span>' +
      '</button>';
  }
  function renderHistory() {
    var scans = history.scans;
    var recentEl = $('recentScans');
    if (!scans.length) {
      recentEl.innerHTML = '<div class="empty-inline">' + (history.loaded ? 'No saved scans yet. <button class="link-btn" id="recentScanLink" type="button">Scan your first tree</button>' : 'Loading your scans…') + '</div>';
      var l = $('recentScanLink'); if (l) l.addEventListener('click', function () { switchView('scan'); });
    } else {
      recentEl.innerHTML = scans.slice(0, 8).map(historyCardHTML).join('');
    }
    $('historyGrid').innerHTML = scans.map(historyCardHTML).join('');
    $('historyEmpty').style.display = history.loaded && !scans.length ? 'block' : 'none';
    $('historyCount').textContent = history.total ? history.total + (history.total === 1 ? ' scan' : ' scans') : '';

    // stats from real data
    var now = new Date();
    var month = scans.filter(function (s) { var d = new Date(s.created_at); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
    var attention = function (s) { return s.health_status === 'Needs attention' || s.health_status === 'Unhealthy' || s.health_status === 'Minor concerns'; };
    var speciesSet = {};
    scans.forEach(function (s) { if (s.scientific_name && s.scientific_name !== 'Unknown') speciesSet[s.scientific_name.toLowerCase()] = 1; });
    $('mScanned').textContent = month.length;
    $('mHealthy').textContent = month.filter(function (s) { return s.health_status === 'Healthy'; }).length;
    $('mAttention').textContent = month.filter(attention).length;
    $('mSpecies').textContent = Object.keys(speciesSet).length;
    $('pScans').textContent = history.total || scans.length;
    $('pSpecies').textContent = Object.keys(speciesSet).length;
    $('pAttention').textContent = scans.filter(attention).length;
  }
  async function loadHistory() {
    if (!user) return;
    try {
      var r = await api('/api/scan-history?limit=60');
      history = { loaded: true, total: r.total || 0, scans: r.scans || [] };
    } catch (e) {
      history.loaded = true;
      $('recentScans').innerHTML = '<div class="empty-inline">' + esc(e.message) + ' <button class="link-btn" id="retryHist" type="button">Retry</button></div>';
      var b = $('retryHist'); if (b) b.addEventListener('click', loadHistory);
      return;
    }
    renderHistory();
    if (!lastContextPath && history.scans.length) lastContextPath = 'history';
  }
  function onScanCard(e) {
    var card = e.target.closest && e.target.closest('.scan-card[data-scan]');
    if (!card) return;
    var id = card.getAttribute('data-scan');
    var s = history.scans.filter(function (x) { return x.id === id; })[0];
    if (s) openScanModal(s);
  }
  $('recentScans').addEventListener('click', onScanCard);
  $('historyGrid').addEventListener('click', onScanCard);

  function openScanModal(s) {
    var a = scanToAnalysis(s);
    var html = '<h2 style="margin-bottom:2px">Scan details</h2><p class="sub" style="margin-top:2px">' + esc(new Date(s.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })) + '</p>' +
      renderAnalysis(a, { imageUrl: s.image_url }) +
      '<div class="modal-actions"><button class="btn-small primary" id="mdAsk" type="button">Ask TreeAI</button>' +
      '<button class="btn-small danger" id="mdDelete" type="button">Delete scan</button>' +
      '<button class="btn-small" id="mdClose" type="button">Close</button></div>';
    openModal(html);
    animateBars($('modalBody'));
    $('mdClose').addEventListener('click', closeModal);
    $('mdAsk').addEventListener('click', function () {
      chatContext = contextFrom(a);
      closeModal(); switchView('chat'); $('chatInput').focus();
    });
    var del = $('mdDelete'), armed = false;
    del.addEventListener('click', async function () {
      if (!armed) { armed = true; del.textContent = 'Tap again to confirm'; setTimeout(function () { armed = false; if (del.isConnected) del.textContent = 'Delete scan'; }, 4000); return; }
      del.disabled = true; del.textContent = 'Deleting…';
      try {
        await api('/api/scan-history?id=' + encodeURIComponent(s.id), { method: 'DELETE' });
        history.scans = history.scans.filter(function (x) { return x.id !== s.id; });
        history.total = Math.max(0, history.total - 1);
        renderHistory();
        closeModal();
        toast('Scan deleted', 'ok');
      } catch (e) {
        del.disabled = false; del.textContent = 'Delete scan';
        toast(e.message, 'error');
      }
    });
  }
  function scanToAnalysis(s) {
    return {
      tree_name: s.tree_name, tamil_name: s.tamil_name, scientific_name: s.scientific_name, family: s.family,
      plant_part: s.plant_part, confidence: s.confidence, health_status: s.health_status, disease: s.disease,
      disease_confidence: s.disease_confidence, severity: s.severity, summary: s.summary,
      symptoms: s.symptoms || [], causes: s.causes || [], treatment: s.treatment || [],
      prevention: s.prevention || [], observations: s.observations || [],
      disclaimer: 'This is an AI assessment based only on the visible image, not a laboratory diagnosis. For important decisions, confirm with a qualified agricultural or forestry expert.'
    };
  }

  /* ---------------------------------------------------------------- result rendering */
  function section(title, items) {
    if (!items || !items.length) return '';
    return '<div class="res-section"><h4>' + esc(title) + '</h4><ul>' +
      items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul></div>';
  }
  function cell(k, v, color) {
    return '<div class="info-cell"><div class="k">' + esc(k) + '</div><div class="v"' + (color ? ' style="color:' + color + '"' : '') + '>' + esc(v) + '</div></div>';
  }
  function renderAnalysis(a, opts) {
    opts = opts || {};
    var unknown = a.tree_name === 'Unknown';
    var noDisease = /^(none visible|unknown)$/i.test(a.disease);
    var h = '';
    if (opts.imageUrl) h += '<img class="result-img" src="' + esc(opts.imageUrl) + '" alt="Scanned tree image"/>';
    h += '<div class="result-name"><h2>' + esc(unknown ? 'Unidentified tree' : a.tree_name) + '</h2>' +
      '<div class="tamil">' + esc(a.tamil_name) + '</div><div class="sci">' + esc(a.scientific_name) + '</div></div>';
    h += '<div class="tag-row">' +
      '<span class="tag">Family: ' + esc(a.family) + '</span>' +
      (a.plant_part && a.plant_part !== 'Unknown' ? '<span class="tag">Shown: ' + esc(a.plant_part) + '</span>' : '') + '</div>';
    h += '<div class="conf-wrap"><div class="conf-label"><span>AI confidence</span><span>' + esc(a.confidence) + '%</span></div>' +
      '<div class="conf-track"><div class="conf-fill" data-w="' + esc(a.confidence) + '"></div></div></div>';
    h += '<div class="info-grid">' +
      cell('Health', a.health_status, healthColor(a.health_status)) +
      cell('Disease', a.disease) +
      cell('Disease confidence', noDisease && a.disease_confidence === 0 ? '—' : a.disease_confidence + '%') +
      cell('Severity', a.severity, sevColor(a.severity)) + '</div>';
    h += '<p class="result-desc">' + esc(a.summary) + '</p>';
    h += section('Symptoms', a.symptoms) + section('Possible causes', a.causes) +
      section('Management / treatment', a.treatment) + section('Prevention', a.prevention) +
      section('Additional observations', a.observations);
    h += '<p class="note">' + esc(a.disclaimer) + '</p>';
    return h;
  }
  function animateBars(root) {
    requestAnimationFrame(function () {
      setTimeout(function () {
        root.querySelectorAll('.conf-fill[data-w]').forEach(function (b) { b.style.width = b.getAttribute('data-w') + '%'; });
      }, 60);
    });
  }

  /* ---------------------------------------------------------------- scanner */
  var dropzone = $('dropzone');
  var scanStatus = $('scanStatus');
  var resultPanel = $('resultPanel');
  var fileInput = $('fileInput');
  var cameraInput = $('cameraInput');
  var progressFill = $('scanProgressFill');
  var stepTimer = null;

  function setProgress(p) { progressFill.style.width = p + '%'; }
  function setStatus(msg, isError) {
    scanStatus.textContent = msg || '';
    scanStatus.classList.toggle('error', !!isError);
  }
  function setScanButtons(disabled) {
    ['uploadBtn', 'cameraBtn'].forEach(function (id) { $(id).disabled = disabled; });
  }
  function resetScannerUI() {
    dropzone.classList.remove('has-preview', 'scanning', 'dragging');
    setProgress(0); setStatus('');
    $('dzTitle').textContent = 'Align the tree inside the frame';
    if (scan.previewUrl) { URL.revokeObjectURL(scan.previewUrl); }
    $('previewImg').removeAttribute('src');
    setScanButtons(false);
  }

  $('uploadBtn').addEventListener('click', function () { fileInput.value = ''; fileInput.click(); });
  $('cameraBtn').addEventListener('click', function () { cameraInput.value = ''; cameraInput.click(); });
  fileInput.addEventListener('change', function () { if (fileInput.files.length) handleFile(fileInput.files[0]); });
  cameraInput.addEventListener('change', function () { if (cameraInput.files.length) handleFile(cameraInput.files[0]); });

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      if (scan.busy) return;
      dropzone.classList.toggle('dragging', evt === 'dragover' || evt === 'dragenter');
      if (evt === 'drop') {
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) handleFile(f); else setStatus('No image found — please drop an image file.', true);
      }
    });
  });
  // keep the browser from opening a dropped file anywhere else on the page
  ['dragover', 'drop'].forEach(function (evt) { window.addEventListener(evt, function (e) { e.preventDefault(); }); });

  function validateFile(file) {
    if (!file) return 'Please choose an image to scan.';
    var t = (file.type || '').toLowerCase();
    if (t && t.indexOf('image/') !== 0) return 'That file is not an image. Please choose a JPG, PNG or WebP photo.';
    if (t === 'image/svg+xml' || t === 'image/gif') return 'Please choose a photo (JPG, PNG or WebP), not a ' + (t === 'image/gif' ? 'GIF' : 'vector') + ' file.';
    if (!t && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || '')) return 'Please choose a JPG, PNG or WebP photo.';
    var maxMB = (cfg && cfg.maxUploadMB) || 10;
    if (file.size > maxMB * 1024 * 1024) return 'That image is larger than ' + maxMB + ' MB. Please choose a smaller one.';
    if (file.size === 0) return 'That image file is empty.';
    return null;
  }

  async function loadBitmap(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* fall through */ }
    }
    return await new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }
  async function resizeToJpeg(file) {
    var bmp = await loadBitmap(file);
    var w = bmp.width, h = bmp.height;
    if (!w || !h) throw new Error('decode');
    var scale = Math.min(1, MAX_DIM / Math.max(w, h));
    var cw = Math.round(w * scale), ch = Math.round(h * scale);
    var canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(bmp, 0, 0, cw, ch);
    if (bmp.close) bmp.close();
    var q = 0.86, blob = null;
    for (var i = 0; i < 3; i++) {
      blob = await new Promise(function (res) { canvas.toBlob(res, 'image/jpeg', q); });
      if (!blob) throw new Error('encode');
      if (blob.size <= 4 * 1024 * 1024) break;
      q -= 0.2;
    }
    return blob;
  }

  var STEP_MESSAGES = ['Analyzing visual features…', 'Identifying tree species…', 'Checking visible health symptoms…', 'Preparing tree profile…'];
  function startAnalysisSteps() {
    var i = 0;
    setStatus(STEP_MESSAGES[0]); setProgress(45);
    stepTimer = setInterval(function () {
      if (i < STEP_MESSAGES.length - 1) {
        i++; setStatus(STEP_MESSAGES[i]); setProgress(45 + i * 14);
      }
    }, 2400);
  }
  function stopAnalysisSteps() { clearInterval(stepTimer); stepTimer = null; }

  function discardUnsavedImage() {
    if (scan.imagePath && !scan.saved && sb) {
      sb.storage.from(BUCKET).remove([scan.imagePath]).catch(function () {});
    }
  }

  async function handleFile(file) {
    if (!user || !sb) { toast('Please sign in first.', 'error'); return; }
    if (scan.busy) { toast('A scan is already in progress.'); return; }
    var problem = validateFile(file);
    if (problem) { setStatus(problem, true); toast(problem, 'error'); return; }

    discardUnsavedImage();
    resultPanel.classList.remove('show');
    resetScannerUI();
    scan = freshScan();
    scan.busy = true;
    scan.state = 'IMAGE SELECTED';
    scan.previewUrl = URL.createObjectURL(file);
    $('previewImg').src = scan.previewUrl;
    dropzone.classList.add('has-preview', 'scanning');
    $('dzTitle').textContent = 'Scanning your image';
    setScanButtons(true);

    try {
      // 1) prepare
      setStatus('Preparing image…'); setProgress(10);
      var blob;
      try { blob = await resizeToJpeg(file); }
      catch (e) { throw new ApiError('INVALID_FILE', 'We could not read that image. Please try a different JPG, PNG or WebP photo.', 0); }

      // 2) upload to Supabase Storage
      scan.state = 'UPLOADING';
      setStatus('Uploading image…'); setProgress(28);
      var path = user.id + '/' + Date.now() + '-' + uid() + '.jpg';
      var up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false, cacheControl: '3600' });
      if (up.error) {
        throw new ApiError('UPLOAD_FAILED', 'The image could not be uploaded. Please check your connection and try again.', 0);
      }
      scan.imagePath = path;

      // 3) real Gemini analysis through our backend
      scan.state = 'AI ANALYZING';
      startAnalysisSteps();
      var r = await api('/api/analyze-tree', { method: 'POST', body: { image_path: path } });
      stopAnalysisSteps();

      // 4) result
      scan.analysis = r.analysis;
      scan.species = r.species || null;
      scan.state = 'RESULT READY';
      showResult();
    } catch (err) {
      stopAnalysisSteps();
      discardUnsavedImage();
      scan.imagePath = null;
      scan.analysis = null;
      var msg = err && err.message ? err.message : 'Something went wrong. Please try again.';
      scan.state = 'IDLE';
      dropzone.classList.remove('scanning');
      $('dzTitle').textContent = err && err.code === 'NOT_A_TREE' ? 'This doesn\'t look like a tree' : 'Scan didn\'t finish';
      setStatus(msg, true); setProgress(0);
      toast(msg, 'error');
    } finally {
      scan.busy = false;
      dropzone.classList.remove('scanning');
      setScanButtons(false);
    }
  }

  function showResult() {
    var a = scan.analysis;
    var unknown = a.tree_name === 'Unknown';
    $('resultBody').innerHTML = renderAnalysis(a, { imageUrl: scan.previewUrl });
    $('resultBadge').textContent = unknown ? 'Could not identify' : (a.confidence < 50 ? 'Possible match' : 'Tree identified');
    var save = $('saveBtn');
    save.disabled = false; save.textContent = 'Save result';
    resultPanel.classList.add('show');
    animateBars($('resultBody'));
    setProgress(100);
    $('dzTitle').textContent = unknown ? 'Analysis complete' : 'Analysis complete';
    setStatus(unknown ? 'Result ready — tree not identified' : 'Tree identified');
    chatContext = contextFrom(a);
    if (window.matchMedia('(max-width: 980px)').matches) {
      setTimeout(function () { resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 250);
    }
    if (!unknown) {
      addMsg('I have your scan of ' + a.tree_name + ' in mind now — ask me anything about it.', 'bot', true);
    }
  }

  $('saveBtn').addEventListener('click', async function () {
    if (!scan.analysis || !scan.imagePath || scan.saved || scan.saving) return;
    var btn = $('saveBtn');
    scan.saving = true; btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await api('/api/save-scan', {
        method: 'POST',
        body: { image_path: scan.imagePath, analysis: scan.analysis, species_id: scan.species ? scan.species.id : undefined }
      });
      scan.saved = true;
      btn.textContent = 'Saved ✓';
      toast('Scan saved successfully', 'ok');
      loadHistory();
    } catch (e) {
      if (e.code === 'ALREADY_SAVED') {
        scan.saved = true; btn.textContent = 'Saved ✓'; toast('This scan is already saved', 'ok'); loadHistory();
      } else {
        btn.disabled = false; btn.textContent = 'Save result';
        toast(e.message, 'error');
      }
    } finally {
      scan.saving = false;
    }
  });

  $('healthBtn').addEventListener('click', function () {
    if (!scan.analysis) return;
    switchView('chat');
    sendChat('Please explain the health findings of my scanned ' + (scan.analysis.tree_name === 'Unknown' ? 'tree' : scan.analysis.tree_name) + ' in simple words and what I should do next.');
  });
  $('askBtn').addEventListener('click', function () { switchView('chat'); $('chatInput').focus(); });

  /* ---------------------------------------------------------------- chat */
  var chatBody = $('chatBody');
  var chatInput = $('chatInput');
  var chatContext = null;
  function contextFrom(a) {
    return { tree_name: a.tree_name, scientific_name: a.scientific_name, health_status: a.health_status, disease: a.disease, severity: a.severity, symptoms: (a.symptoms || []).slice(0, 5) };
  }
  function addMsg(text, who, skipHistory) {
    var d = document.createElement('div');
    d.className = 'msg ' + who;
    d.textContent = text;
    chatBody.appendChild(d);
    chatBody.scrollTop = chatBody.scrollHeight;
    if (!skipHistory) chatHistory.push({ role: who === 'user' ? 'user' : 'bot', text: text });
  }
  async function sendChat(text) {
    text = (text || chatInput.value).trim();
    if (!text || chatBusy) return;
    if (!user) { toast('Please sign in first.', 'error'); return; }
    chatBusy = true;
    $('sendBtn').disabled = true;
    addMsg(text, 'user');
    chatInput.value = '';
    var typing = document.createElement('div');
    typing.className = 'msg bot';
    typing.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
    chatBody.appendChild(typing);
    chatBody.scrollTop = chatBody.scrollHeight;

    var ctx = chatContext;
    if (!ctx && history.scans.length) ctx = contextFrom(scanToAnalysis(history.scans[0]));
    try {
      var r = await api('/api/chat', { method: 'POST', body: { messages: chatHistory.slice(-10), context: ctx || undefined } });
      typing.remove();
      addMsg(r.reply, 'bot');
    } catch (e) {
      typing.remove();
      addMsg(e.message, 'bot', true);
    } finally {
      chatBusy = false;
      $('sendBtn').disabled = false;
    }
  }
  $('sendBtn').addEventListener('click', function () { sendChat(); });
  chatInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChat(); });
  document.querySelectorAll('.suggest-chip').forEach(function (c) {
    c.addEventListener('click', function () { sendChat(c.getAttribute('data-q')); });
  });

  var recognizing = null;
  $('micBtn').addEventListener('click', function () {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { addMsg('Voice input isn\'t supported in this browser — please type your question instead.', 'bot', true); return; }
    if (recognizing) { recognizing.stop(); return; }
    var rec = new SR();
    rec.lang = 'en-IN'; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = function (ev) { chatInput.value = ev.results[0][0].transcript; chatInput.focus(); };
    rec.onerror = function () { toast('Could not hear you — please try again or type.', 'error'); };
    rec.onend = function () { recognizing = null; $('micBtn').style.color = ''; };
    try { rec.start(); recognizing = rec; $('micBtn').style.color = 'var(--leaf)'; } catch (e) { recognizing = null; }
  });

  /* ---------------------------------------------------------------- profile actions */
  document.querySelectorAll('.settings-item[data-action]').forEach(function (el) {
    el.addEventListener('click', function () {
      var a = el.getAttribute('data-action');
      if (a === 'history') switchView('history');
      if (a === 'privacy') {
        openModal('<h2>Privacy &amp; data</h2>' +
          '<p class="sub">Photos you scan are stored in a private folder that only your account can open. They are sent to Google\'s Gemini AI to produce the analysis.</p>' +
          '<p class="sub">Only scans you choose to save are kept in your history. Unsaved photos are discarded. You can delete any saved scan — and its photo — from the scan details screen.</p>' +
          '<p class="sub">Photos are resized in your browser before upload, which also removes location data stored inside the original file.</p>');
      }
      if (a === 'about') {
        openModal('<h2>About TreeAI</h2>' +
          '<p class="sub">TreeAI helps you identify trees of Tamil Nadu and spot visible health problems from a photo, using Gemini multimodal AI.</p>' +
          '<p class="sub">Results are AI assessments from an image — not laboratory diagnoses. For important decisions, confirm with a qualified agricultural or forestry expert such as your local Krishi Vigyan Kendra or a TNAU extension officer.</p>');
      }
    });
  });

  /* ---------------------------------------------------------------- start */
  renderHistory();
  setGreeting();
  init();
})();
