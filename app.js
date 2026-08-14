import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const cfg = window.APP_CONFIG || {};

const $ = (id) => document.getElementById(id);

if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("TAVO-PROJEKTAS")) {
  document.body.innerHTML =
    '<p style="padding:2rem;font-family:system-ui;line-height:1.6">' +
    "Faile <b>config.js</b> dar neįrašyti Supabase duomenys. " +
    "Juos rasi Supabase → Project Settings → API.</p>";
  throw new Error("config.js nesukonfigūruotas");
}

const db = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

/* ---------- formatavimas ---------- */

const eur = new Intl.NumberFormat("lt-LT", {
  style: "currency", currency: "EUR", minimumFractionDigits: 2
});

const MONTHS = ["sausis","vasaris","kovas","balandis","gegužė","birželis",
                "liepa","rugpjūtis","rugsėjis","spalis","lapkritis","gruodis"];
const WEEKDAYS = ["sekmadienis","pirmadienis","antradienis","trečiadienis",
                  "ketvirtadienis","penktadienis","šeštadienis"];

const money = (n) => eur.format(n || 0);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

/* ---------- būsena ---------- */

const state = {
  user: null,
  month: new Date(),
  categories: [],
  transactions: [],
  editing: null,
  formType: "expense"
};

/* ---------- pranešimai ---------- */

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/* =========================================================
   PRISIJUNGIMAS
   ========================================================= */

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn");
  const err = $("login-error");
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "Jungiamasi…";

  const { error } = await db.auth.signInWithPassword({
    email: $("login-email").value.trim(),
    password: $("login-pass").value
  });

  btn.disabled = false;
  btn.textContent = "Prisijungti";

  if (error) {
    err.textContent = "Neteisingas el. paštas arba slaptažodis.";
    err.hidden = false;
  }
});

$("logout").addEventListener("click", async () => {
  await db.auth.signOut();
});

db.auth.onAuthStateChange((_event, session) => {
  state.user = session?.user || null;
  if (state.user) {
    $("login").hidden = true;
    $("app").hidden = false;
    start();
  } else {
    $("app").hidden = true;
    $("login").hidden = false;
  }
});

// atsarginis variantas, jei įvykis nesuveiktų
db.auth.getSession().then(({ data }) => {
  if (!data.session && $("login").hidden && $("app").hidden) {
    $("login").hidden = false;
  }
});

/* =========================================================
   DUOMENYS
   ========================================================= */

function monthRange(d) {
  const from = new Date(d.getFullYear(), d.getMonth(), 1);
  const to   = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return [iso(from), iso(to)];
}

async function loadCategories() {
  const { data, error } = await db
    .from("categories")
    .select("id, name, type, icon")
    .order("sort_order");
  if (error) { toast("Nepavyko įkelti kategorijų"); return; }
  state.categories = data || [];
}

async function loadTransactions() {
  const [from, to] = monthRange(state.month);
  const { data, error } = await db
    .from("transactions")
    .select("id, type, amount, date, description, vendor, category_id, categories(name, icon)")
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) { toast("Nepavyko įkelti įrašų"); return; }
  state.transactions = data || [];
}

async function refresh() {
  await loadTransactions();
  render();
}

async function start() {
  renderMonth();
  await loadCategories();
  await refresh();
}

/* =========================================================
   VAIZDAS
   ========================================================= */

function renderMonth() {
  $("month-label").textContent =
    `${MONTHS[state.month.getMonth()]} ${state.month.getFullYear()}`;
}

function render() {
  renderMonth();

  let income = 0, expense = 0;
  for (const t of state.transactions) {
    const a = Number(t.amount);
    if (t.type === "income") income += a; else expense += a;
  }

  $("sum-income").textContent  = money(income);
  $("sum-expense").textContent = money(expense);
  const balance = income - expense;
  $("balance").textContent = money(balance);
  $("balance").classList.toggle("is-negative", balance < 0);

  const ledger = $("ledger");
  ledger.textContent = "";

  if (!state.transactions.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Šį mėnesį įrašų dar nėra.";
    ledger.append(p);
    return;
  }

  // grupuojam pagal datą
  const byDate = new Map();
  for (const t of state.transactions) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t);
  }

  for (const [date, items] of byDate) {
    const d = new Date(date + "T12:00:00");
    const dayTotal = items.reduce(
      (s, t) => s + (t.type === "income" ? Number(t.amount) : -Number(t.amount)), 0);

    const day = document.createElement("section");
    day.className = "day";

    const head = document.createElement("div");
    head.className = "day__head";

    const label = document.createElement("span");
    label.className = "day__date";
    label.textContent = `${d.getDate()} ${MONTHS[d.getMonth()]}, ${WEEKDAYS[d.getDay()]}`;

    const total = document.createElement("span");
    total.className = "day__total";
    total.textContent = (dayTotal >= 0 ? "+" : "−") + money(Math.abs(dayTotal));

    head.append(label, total);
    day.append(head);

    for (const t of items) {
      const row = document.createElement("button");
      row.className = "row";
      row.type = "button";
      row.addEventListener("click", () => openSheet(t.type, t));

      const name = document.createElement("span");
      name.className = "row__name";
      name.textContent = t.vendor || t.description || "Įrašas";

      const cat = document.createElement("span");
      cat.className = "row__cat";
      const c = t.categories;
      cat.textContent = c ? `${c.icon || ""} ${c.name}`.trim() : "Be kategorijos";
      name.append(cat);

      const leader = document.createElement("span");
      leader.className = "row__leader";

      const amt = document.createElement("span");
      amt.className = "row__amt " + (t.type === "income" ? "row__amt--in" : "row__amt--out");
      amt.textContent = (t.type === "income" ? "+" : "−") + money(Number(t.amount));

      row.append(name, leader, amt);
      day.append(row);
    }

    ledger.append(day);
  }
}

/* ---------- mėnesio perjungimas ---------- */

$("prev-month").addEventListener("click", () => {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1);
  refresh();
});

$("next-month").addEventListener("click", () => {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1);
  refresh();
});

/* =========================================================
   ĮRAŠO FORMA
   ========================================================= */

function fillCategories(type, selected) {
  const sel = $("f-category");
  sel.textContent = "";

  const none = document.createElement("option");
  none.value = "";
  none.textContent = "Be kategorijos";
  sel.append(none);

  for (const c of state.categories.filter((c) => c.type === type)) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = `${c.icon || ""} ${c.name}`.trim();
    sel.append(o);
  }
  sel.value = selected || "";
}

function openSheet(type, tx = null) {
  state.formType = type;
  state.editing = tx;

  $("sheet-title").textContent = tx
    ? "Redaguoti įrašą"
    : (type === "income" ? "Naujos pajamos" : "Nauja išlaida");

  $("f-amount").value = tx ? String(tx.amount).replace(".", ",") : "";
  $("f-date").value   = tx ? tx.date : iso(new Date());
  $("f-vendor").value = tx?.vendor || "";
  $("f-desc").value   = tx?.description || "";
  fillCategories(type, tx?.category_id);

  $("delete-btn").hidden = !tx;
  $("sheet-error").hidden = true;
  $("sheet").hidden = false;

  if (!tx) setTimeout(() => $("f-amount").focus(), 120);
}

function closeSheet() {
  $("sheet").hidden = true;
  state.editing = null;
}

$("add-expense").addEventListener("click", () => openSheet("expense"));
$("add-income").addEventListener("click",  () => openSheet("income"));

document.querySelectorAll("[data-close]").forEach((el) =>
  el.addEventListener("click", closeSheet));

$("tx-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const raw = $("f-amount").value.replace(/\s/g, "").replace(",", ".");
  const amount = Number(raw);
  const err = $("sheet-error");

  if (!Number.isFinite(amount) || amount <= 0) {
    err.textContent = "Įvesk sumą, didesnę už nulį.";
    err.hidden = false;
    return;
  }

  const btn = $("save-btn");
  btn.disabled = true;
  btn.textContent = "Saugoma…";

  const payload = {
    user_id: state.user.id,
    type: state.formType,
    amount: amount.toFixed(2),
    date: $("f-date").value,
    category_id: $("f-category").value || null,
    vendor: $("f-vendor").value.trim() || null,
    description: $("f-desc").value.trim() || null
  };

  const { error } = state.editing
    ? await db.from("transactions").update(payload).eq("id", state.editing.id)
    : await db.from("transactions").insert(payload);

  btn.disabled = false;
  btn.textContent = "Išsaugoti";

  if (error) {
    err.textContent = "Nepavyko išsaugoti. Patikrink ryšį ir bandyk dar kartą.";
    err.hidden = false;
    return;
  }

  closeSheet();
  toast(state.editing ? "Įrašas atnaujintas" : "Įrašas išsaugotas");

  // jei įrašas ne šio mėnesio — persijungiam į jo mėnesį
  const d = new Date(payload.date + "T12:00:00");
  if (d.getMonth() !== state.month.getMonth() || d.getFullYear() !== state.month.getFullYear()) {
    state.month = d;
  }
  refresh();
});

$("delete-btn").addEventListener("click", async () => {
  if (!state.editing) return;
  if (!confirm("Ištrinti šį įrašą?")) return;

  const { error } = await db.from("transactions").delete().eq("id", state.editing.id);
  if (error) { toast("Nepavyko ištrinti"); return; }

  closeSheet();
  toast("Įrašas ištrintas");
  refresh();
});

/* =========================================================
   PWA
   ========================================================= */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
