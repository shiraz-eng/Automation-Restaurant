// Pre-written answers for the AI Guide's recommended questions and their
// follow-up chips — served instantly, with no AI round trip. They state the
// same facts as ./knowledge.ts; keep both in step. Each answer's
// [[SUGGEST]] line uses phrases that are themselves keys below, so a guided
// conversation stays instant. Anything typed freely still goes to the AI.

type Entry = { keys: string[]; answer: string };

const E: Entry[] = [
  // ── Public: value ──────────────────────────────────────────────────────
  {
    keys: ['What will Automation Restaurant actually do for my restaurant day to day?', 'What will it do for my restaurant?'],
    answer: `It runs the whole restaurant from one place, with every screen using the same live data:
- **Orders & checkout** — POS, guest QR ordering from the table, payments, receipts, refunds.
- **Kitchen display** — orders appear instantly by station; the kitchen marks them ready.
- **Food availability runs itself** — when an ingredient runs out, dishes that need it come off the customer menu automatically.
- **Recipes & food cost** — real cost and margin per dish, deal and day.
- **Stock & suppliers** — stock goes down as you sell; purchase orders, deliveries and supplier bills.
- **Team** — staff, shifts, attendance, and separate logins per station with only the access they need.
- **AI** — import your menu from a photo, ask "how did we do this week?"
Most restaurants are set up in about 15 minutes.
[[SUGGEST]] Walk me through setup step by step | Which plan fits my restaurant? | Is my data safe and mine?`,
  },
  {
    keys: ['How does automatic food availability work, and why does it matter?', 'How does food availability run itself?', 'How does food availability work?'],
    answer: `Each dish has a **recipe** that lists its ingredients. The system uses it to work out, at every moment, how many portions the kitchen can still make:
1. A sale, a waste entry or a stock count lowers the ingredient stock.
2. A delivery or restock raises it.
3. After every change, the affected dishes are recalculated automatically.

When a dish can't be made, it disappears from the customer menu and the till by itself. Guests can't order what you don't have, and the kitchen stops apologising. With **Priority Allocation** you can decide which dishes get scarce ingredients first.
[[SUGGEST]] How do the percentages work? | Walk me through setup step by step | Which plan fits my restaurant?`,
  },
  {
    keys: ['Can each station or staff member get their own login with limited access?', 'Can my staff each get their own login?'],
    answer: `Yes — two ways:
- **Staff accounts** — each person gets a login with a role (cashier, chef, waiter, manager…).
- **Portals** — a shared login for a station (e.g. "Counter 1", "Kitchen", "Attendance kiosk"). You tick exactly which permissions it has, and a **live preview** shows what it will see before you create it.

Permissions are enforced by the database itself, not just hidden on screen — a counter login can't approve refunds or see profit unless you allow it.
[[SUGGEST]] Walk me through setup step by step | Is my data safe and mine? | Which plan fits my restaurant?`,
  },

  // ── Public: setup & Supabase ──────────────────────────────────────────
  {
    keys: ['Walk me through the whole setup step by step. How long does it take?', 'Walk me through setup step by step', 'How does setup work?', 'How do I get started?'],
    answer: `About **10–15 minutes** end to end:
1. **Create your account** at Get started — restaurant name, your details, number of tables, plan. (~2 min)
2. **Pay** for the plan by card.
3. **Connect Supabase** — sign in with your own Supabase account (free to create) and approve. We create your database for you; no keys, no code. (~2 min)
4. **Automatic setup** — a status page ticks through each step. (~2–5 min)
5. **Set your password** from the email we send (check spam).
6. **Sign in** at your restaurant's own login page and follow the first-week checklist.
[[SUGGEST]] Why do I need a Supabase account? | What do I need before I start? | What does it cost in total?`,
  },
  {
    keys: ['What is Supabase, why do I connect my own account, and is it free?', 'Why do I need a Supabase account?', 'Is Supabase free?'],
    answer: `**Supabase** is a trusted cloud database service. Your restaurant's data lives in a **dedicated database inside your own Supabase account**, so:
- **You own your data** and can see it in your Supabase dashboard any time.
- It's **isolated** from every other restaurant.

**Cost:** Supabase's **free tier is enough for one restaurant**. They only bill you if you choose a paid Supabase plan. One thing to know: free projects **pause after about a week with no activity**. A restaurant using the system daily won't hit that, and you can resume a paused project in one click.

Setting it up takes about 2 minutes. You never copy keys or write code.
[[SUGGEST]] How do I connect Supabase? | Supabase says no room for a project | What does it cost in total?`,
  },
  {
    keys: ['How do I connect Supabase?', 'How do I connect my account?'],
    answer: `After payment you'll see **Connect your Supabase account**:
1. Click **Connect Supabase**.
2. Sign in to Supabase with **your own** account, or create one free at supabase.com (email or GitHub).
3. Pick or create **your own organization**, then click **Authorize**.
4. You're sent back and setup starts automatically.

Tips: use a computer and stay in the same browser. Choose *your* organization, not one named after Automation Restaurant.
[[SUGGEST]] Supabase says no room for a project | Setup is stuck | What happens after setup?`,
  },
  {
    keys: ['Supabase says no room for a project', 'It says the organization has no room for a new project. What do I do?'],
    answer: `Supabase's free tier allows **2 active projects per organization**, and yours is full. Any of these fixes it:
1. **Pick another organization** when you authorize, or create a new free one.
2. **Pause or delete an unused project** in your Supabase dashboard.
3. **Upgrade that organization** to a paid Supabase plan.

Then click **Try connecting again** on the setup page.
[[SUGGEST]] Setup is stuck | How do I connect Supabase? | What happens after setup?`,
  },
  {
    keys: ['Setup is stuck', 'What if setup gets stuck?'],
    answer: `Setup normally finishes in **2–5 minutes**:
- **Stuck on "Setting up…" for over 10 minutes** → refresh the status page once.
- **"Authorization was cancelled"** → click **Connect Supabase** again and press Authorize.
- **"That organization belongs to Automation Restaurant"** → sign in with *your own* Supabase account and pick your own organization.
- **Still stuck, or it shows an error** → contact support with your restaurant name. Nothing is lost, and we can resume from where it stopped.
[[SUGGEST]] Supabase says no room for a project | What happens after setup? | How do I contact support?`,
  },
  {
    keys: ['What happens after setup?', 'What happens after I sign up?'],
    answer: `When setup completes:
1. You get an email to **set your owner password** (check spam/promotions).
2. You sign in at **/r/your-restaurant/login**. Bookmark it; staff use it too.
3. Follow the checklist: **Brand Kit → Menu (or AI import from a photo) → Tables & QR → Inventory → Recipes → Staff → Portals**.
4. Place a **test order** by scanning a table QR code with your phone.
[[SUGGEST]] What do I need before I start? | Is my data safe and mine? | Which plan fits my restaurant?`,
  },
  {
    keys: ['What should I have ready before I sign up?', 'What do I need before I start?'],
    answer: `Have these ready and setup goes smoothly:
- **Business email and phone** for the owner account.
- **Number of tables** (you can change it later).
- **A card** for the plan.
- **A Supabase account** — or create one free during setup (email or GitHub).
- Handy for day one: your **menu** (a photo or PDF is fine — AI can import it), your **logo**, and a rough list of **ingredients and staff**.
[[SUGGEST]] Walk me through setup step by step | Why do I need a Supabase account? | Which plan fits my restaurant?`,
  },

  // ── Public: plans & trust ─────────────────────────────────────────────
  {
    keys: ['Which plan fits a restaurant like mine? Compare the plans.', 'Which plan fits my restaurant?', 'Compare the plans'],
    answer: `- **Starter — $49/mo** ($39 billed annually). Cafés and small restaurants: POS, QR table ordering, up to 5 users and 20 tables.
- **Professional — $129/mo** ($103 annually). Most full-service restaurants: adds the **real-time kitchen display**, **recipes and inventory deduction** (automatic availability and food cost), staff and a branded menu. 20 users, unlimited tables.
- **Enterprise — custom.** Groups with several branches: multi-branch, kitchen station routing, custom branding, dedicated support.

Rule of thumb: if you have a kitchen team and care about food cost, choose **Professional**.
[[SUGGEST]] What does it cost in total? | Walk me through setup step by step | Is my data safe and mine?`,
  },
  {
    keys: ['What will it cost in total, including the database?', 'What does it cost in total?'],
    answer: `There are two separate bills:
1. **Automation Restaurant plan** — $49, $129 or custom per month. Paying annually saves about 20%.
2. **Supabase (your database)** — **free** on Supabase's free tier, which is enough for one restaurant. You'd only pay Supabase if you choose to upgrade, for example so the project never pauses from inactivity.

There's no setup fee.
[[SUGGEST]] Which plan fits my restaurant? | Why do I need a Supabase account? | Walk me through setup step by step`,
  },
  {
    keys: ['Is my data safe, and who owns it?', 'Is my data safe and mine?', 'Is my data safe?', 'Who owns my data?'],
    answer: `- **You own it.** Your data lives in a dedicated database inside **your own** Supabase account, not in a shared pool.
- **Isolated.** No other restaurant shares your database.
- **Permissions enforced at the database.** Every login, whether owner, staff or station portal, can only reach what it's allowed. It's not just hidden on screen.
- **Audited.** Important changes (refunds, voids, price overrides, access changes) are recorded with who did them.
- We never ask for your passwords or keys.
[[SUGGEST]] Why do I need a Supabase account? | Which plan fits my restaurant? | Walk me through setup step by step`,
  },
  {
    keys: ['How do I contact support?'],
    answer: `Use the **Contact** page (/contact). Include your **restaurant name**, what you were doing, and any message you saw. A screenshot helps. Never include passwords or keys.
[[SUGGEST]] Setup is stuck | Walk me through setup step by step | Is my data safe and mine?`,
  },

  // ── Portal: first week ────────────────────────────────────────────────
  {
    keys: ['I just got my portal. What should I set up first, in order?', 'What should I set up first?'],
    answer: `Follow this order, since each step builds on the previous one:
1. **Settings → Brand Kit** — logo, colours, receipt details.
2. **Menu** — add dishes, or use **AI → Smart Import** with a photo or PDF of your menu.
3. **Tables & QR** — add tables, then **Print all QR codes**.
4. **Inventory** — ingredients with unit, stock and cost.
5. **Recipes & Food Cost** — link each dish to its ingredients. This switches on automatic availability and food cost.
6. **Staff** — add your team.
7. **Portals** — logins for stations like Counter and Kitchen.
8. Place a **test order** from a table QR code.
[[SUGGEST]] Import my menu from a photo | Link dishes to ingredients | Create a counter login`,
  },
  {
    keys: ['Help me get everything ready for my first real order.', 'Get ready for my first order'],
    answer: `Pre-flight checklist:
1. **Menu** — dishes are on sale, with prices and sizes.
2. **Tables & QR** — QR codes printed and on the tables.
3. **Kitchen** — the **Kitchen display** is open on a screen in the kitchen.
4. **Counter** — someone signed in at **Checkout**, or a Counter portal.
5. **Recipes & stock**, if you use them — ingredients stocked, so no dish shows 0.
6. **Test run** — scan a QR code with your phone, order, watch it appear in the kitchen, mark it ready, then take payment at Checkout.
[[SUGGEST]] Print table QR codes | Create a counter login | A dish shows 0 or Unavailable`,
  },
  {
    keys: ['How do I create logins for my counter and kitchen?', 'Create logins for my stations', 'How do I create a portal?'],
    answer: `Go to **Portals → Create Custom Portal**:
1. Enter a name (e.g. "Counter 1"), and optionally a login email and password.
2. Tick the permissions it needs. **Start from a role** fills in a sensible set.
3. Check the **Live portal preview** on the right. It shows exactly what the station will see.
4. Click **Create portal** and copy the URL, email and password shown. The password appears only once.
[[SUGGEST]] Create a counter login | Test a portal safely | I get a permission error`,
  },

  // ── Portal: page helpers ──────────────────────────────────────────────
  {
    keys: ['How do the Critical/High/Medium/Low percentages decide availability?', 'How do the percentages work?', 'How does Priority Allocation work?'],
    answer: `When several dishes share a limited ingredient, **Priority Allocation** divides what can be made:
1. Turn it **On** under **Menu → Priority Allocation**.
2. Give each priority level a share, e.g. **Critical 40 / High 30 / Medium 20 / Low 10**. The four must total 100%.
3. Put dishes into levels. Dishes with no priority count as **Low**.

Inside a level, the share is split evenly between the dishes and sizes. Any share a dish can't use (because another ingredient runs out first) goes to the others, so nothing sits unused. Stock is never reserved or moved; this only decides what each dish can promise.
[[SUGGEST]] Why is a dish showing 0? | A dish shows 0 or Unavailable | How does food availability work?`,
  },
  {
    keys: ['Why would a dish show 0 available when I have stock?', 'Why is a dish showing 0?', 'A dish shows 0 or Unavailable — how do I fix it?', 'A dish shows 0 or Unavailable'],
    answer: `Read the reason shown under the dish on the **Kitchen → Food availability** board:
- **"<Ingredient> unavailable"** — that ingredient ran out, or the recipe needs more than you have. Restock it in **Inventory** and the dish updates by itself.
- **"Allocated to higher-priority items"** — **Priority Allocation** gave the shared ingredient to other dishes. Adjust the percentages or the dish's level.
- **Wrong numbers** — check the recipe quantities and units in **Recipes & Food Cost** (e.g. 0.2 kg vs 200 g).
- **"No limit"** — the dish has no recipe yet, so stock doesn't limit it.
[[SUGGEST]] How do the percentages work? | Link dishes to ingredients | How does food availability work?`,
  },
  {
    keys: ['How do I import my whole menu from a photo or PDF?', 'Import my menu from a photo', 'How do I import my menu?'],
    answer: `Go to **AI → Smart Import**:
1. Upload a clear **photo or PDF** of your menu. Several pages are fine.
2. The AI drafts categories, dishes, sizes and prices.
3. **Review** the draft and fix anything it misread.
4. **Apply**. The dishes appear in **Menu**, ready to edit.

Smart Import also handles inventory lists, recipes, suppliers, supplier prices, purchase orders and staff sheets.
[[SUGGEST]] Add sizes and add-ons | Link dishes to ingredients | What should I set up first?`,
  },
  {
    keys: ['How do I add sizes (variants) and add-ons to a dish?', 'Add sizes and add-ons'],
    answer: `Open the dish in **Menu**:
- **Sizes (variants)** — add Regular, Large and so on, each with its own price. Each size can have its own recipe too.
- **Add-ons (modifier groups)** — e.g. "Choose your sauce" (required, pick 1) or "Extras" (optional, several), each option with a price.[[SUGGEST]] Link dishes to ingredients | Import my menu from a photo | Build a combo deal`,
  },
  {
    keys: ['How do I create a login for my counter with only the access it needs?', 'Create a counter login'],
    answer: `**Portals → Create Custom Portal**, name it "Counter 1", then tick:
- **Payments:** View payments, Accept payment, View/Print receipts.
- **Orders:** View orders, Create orders.
- Add **Apply discount** or **Refund payment** only if the counter should do those.

The preview shows a **Cashier** section. Create it, then sign the counter device in with the email and password shown.
[[SUGGEST]] Test a portal safely | I get a permission error | Get ready for my first order`,
  },
  {
    keys: ['How do I test a portal without logging myself out?', 'Test a portal safely'],
    answer: `Open the portal in a **private/incognito window**, or a different browser, and sign in there.

A browser keeps one login per restaurant across all its tabs. If you sign in as a portal in another tab of your normal window, your owner tabs switch to that portal too. Keep the owner and the test portal in separate windows.
[[SUGGEST]] I get a permission error | Create a counter login | What should I set up first?`,
  },
  {
    keys: ['I get a "doesn\'t have permission" error. What\'s wrong?', 'I get a permission error', 'Permission error after signing in'],
    answer: `The message names the account that made the request ("Signed in as …"):
- **It names a portal or someone else** → a different login is active in this browser, often a portal you tested in another tab. Sign out, sign in again as yourself, and test portals in an incognito window.
- **It's the right account** → that login doesn't have the permission. The owner can add it under **Portals → Edit access** (for a portal) or **Staff** (for a person).
[[SUGGEST]] Test a portal safely | Create a counter login | Restaurant not loading`,
  },
  {
    keys: ['How do I create a combo deal with a schedule?', 'Build a combo deal'],
    answer: `**Deals & Combos → Create Deal** walks you through 8 steps:
1. **Basic info** — name, type, image.
2. **Select items** — fixed items, plus optional "choose one" groups.
3. **Offer & pricing** — set the deal price; it shows the regular value, savings, food cost and checks.
4. **Rules** — min/max per order, total usage limit.
5. **Availability** — dine-in, takeaway or delivery; customer menu and/or POS.
6. **Schedule** — dates, days of the week, time window.
7. **Customer display** — tagline, badge, "Save X".
8. **Publish**, or Save as Draft / Schedule.
[[SUGGEST]] Deal not on the menu? | How do the percentages work? | Get ready for my first order`,
  },
  {
    keys: ['Why is my deal not showing on the customer menu?', 'Deal not on the menu?'],
    answer: `A deal shows on the customer menu only when all of these are true:
- Status is **Active**, not Draft or Paused.
- Today is within its **dates**, it's one of its **days**, and inside its **time window**.
- The **Customer Portal** channel is ticked in its Availability step.
- Its items can be made, so none are sold out.

Open the deal in **Deals & Combos** to check its status, Schedule and Availability.
[[SUGGEST]] Build a combo deal | A dish shows 0 or Unavailable | Get ready for my first order`,
  },
  {
    keys: ['How does the Food availability board in the kitchen work?', 'How the food board works'],
    answer: `**Kitchen → Food availability** shows how many portions of each dish can be made right now. It's worked out from stock and recipes, and updates live.
- **Available / Low stock / Unavailable**, with the reason, e.g. "Cheese unavailable".
- **Waste** — record burnt or dropped portions. The dish's ingredients are deducted so the numbers stay true.
- **Take off sale** — manually hide a dish (e.g. the fryer is down) without changing stock.
- **"No limit"** — the dish has no recipe linked yet.
[[SUGGEST]] Record wasted food | A dish shows 0 or Unavailable | Link dishes to ingredients`,
  },
  {
    keys: ['How do I record wasted dishes so stock stays right?', 'Record wasted food'],
    answer: `- **Whole dishes** (burnt, dropped, returned): **Kitchen → Food availability → Waste** on that dish, enter the number of portions and a reason. Its recipe ingredients are deducted automatically.
- **Raw ingredients** (spoiled, expired): **Inventory → Waste** on the ingredient.

Either way, availability updates by itself and the waste shows up in food cost.
[[SUGGEST]] How the food board works | Stock goes down by itself? | Link dishes to ingredients`,
  },
  {
    keys: ['How does selling a dish reduce ingredient stock?', 'Stock goes down by itself?', 'How does selling a dish reduce inventory?'],
    answer: `When an order is placed, the dish's **recipe** is used to deduct each ingredient from **Inventory**. Every movement is logged.
- Deliveries, restocks and stock counts add or correct stock.
- After each change, availability recalculates for the dishes using that ingredient.
- The cost of what was used feeds **food cost and profit**.

Dishes without a recipe don't touch stock.
[[SUGGEST]] Low-stock alerts | Link dishes to ingredients | How does food availability work?`,
  },
  {
    keys: ['How do low-stock alerts and reordering work?', 'Low-stock alerts', 'How do low stock alerts work?'],
    answer: `Each ingredient in **Inventory** has a **reorder level**. When stock falls to it, the item is flagged low and appears in **Needs attention**.
- With purchasing automation on, the system can draft a purchase order or email the item's preferred supplier.
- Receive the delivery in **Purchasing** (or restock in Inventory) and stock and availability update straight away.
[[SUGGEST]] Stock goes down by itself? | Link dishes to ingredients | What should I set up first?`,
  },
  {
    keys: ['How do I link a dish to its ingredients and see its food cost?', 'Link dishes to ingredients', 'How do I link a recipe?'],
    answer: `Recipes come first, then you link them to dishes yourself:
1. **Recipes & Food Cost → + Create Recipe** (or import a recipe sheet with **AI → Smart Import**). Add each ingredient with the **quantity per portion**, in the ingredient's unit.
2. **Link it to a dish**, in any of these places:
   - **Menu → open the dish → Recipe & Food Cost → Link a recipe**, or when you **+ Add Product**
   - **AI recipe import**: pick a dish for each recipe in the review
   - **AI menu import**: pick a recipe for each dish in the review

You can pick **any** recipe, even one other dishes already use (e.g. one "Beef Patty" recipe for Single and Double). Each dish or size has one recipe, and a new version of a shared recipe updates every dish using it.

Nothing links automatically. Linking turns the recipe on: you see the dish's cost and margin, each sale deducts stock, and availability is calculated for you. **Unlink** stops that without deleting the recipe, and deleting a dish keeps its recipe too.
[[SUGGEST]] Why recipes matter | A dish shows 0 or Unavailable | How do the percentages work?`,
  },
  {
    keys: ['What do recipes switch on in the rest of the system?', 'Why recipes matter'],
    answer: `A recipe connects a dish to real stock. That switches on:
- **Automatic availability** — sold-out dishes leave the menu by themselves.
- **Stock deduction** on every sale.
- **Food cost, margin and profit** per dish, deal and day.
- **Priority Allocation** for shared ingredients.
- Better **low-stock alerts** and purchasing suggestions.
[[SUGGEST]] Link dishes to ingredients | How do the percentages work? | Low-stock alerts`,
  },
  {
    keys: ['How do I add a staff member and give them a login?', 'Add a team member', 'How do I invite a new employee?'],
    answer: `**Staff → Add staff**: enter their name, choose a **role** (cashier, chef, waiter, manager…) and optionally a shift start time.

A login email and password are generated and **shown once**; give them to the person securely. They sign in at your restaurant's login page. Their role decides what they can do.
[[SUGGEST]] Roles vs portals | Create a counter login | Test a portal safely`,
  },
  {
    keys: ['What is the difference between staff roles and portals?', 'Roles vs portals'],
    answer: `- **Staff role** = a **person's** own login. Their access comes from the role (cashier, chef, manager…). Use it for people.
- **Portal** = a **station's** shared login (Counter 1, Kitchen screen, Attendance kiosk). You tick its exact permissions and preview it first. Use it for devices that several people share.
[[SUGGEST]] Create a counter login | Add a team member | Test a portal safely`,
  },
  {
    keys: ['How do I take a payment and print the receipt?', 'Take a payment'],
    answer: `In **Checkout**:
1. Pick the open bill (or **New order** for a counter order).
2. Choose **cash, card or mobile** and enter the amount. For cash, enter what was handed over to see the change.
3. Click **Take**. The receipt prints automatically; **Print invoice** or **Download PDF** anytime after.
[[SUGGEST]] Refunds and discounts | Create a counter login | Get ready for my first order`,
  },
  {
    keys: ['How do refunds and discounts work at checkout?', 'Refunds and discounts'],
    answer: `- **Discount** — on an open bill, click **Discount** and enter an amount and reason.
- **Refund** — on a payment, click **refund**, then enter the amount and a reason. Refunds above your restaurant's limit (set under **Settings → Policies**) need someone with refund approval.
- **Void** — cancels a payment that hasn't been refunded.

Each is logged with who did it. Give these permissions only to people who need them.
[[SUGGEST]] Take a payment | Create a counter login | I get a permission error`,
  },
  {
    keys: ['How do I set my logo, colours and receipt details?', 'Set up my branding'],
    answer: `**Settings → Brand Kit**:
- Upload your **logo** and pick your **colours**. They're used on the customer menu and portal screens.
- **Receipt Customization** — address, phone, tax number, footer text and what shows on printed and PDF receipts, with a live preview.
[[SUGGEST]] Print table QR codes | What should I set up first? | Take a payment`,
  },
  {
    keys: ['How do I print QR codes for my tables and test them?', 'Print table QR codes'],
    answer: `**Tables & QR**:
1. Add your tables (e.g. "Table 1", seats).
2. Click **Print all QR codes** and place each code on its table.
3. Test one: scan it with your phone, order something, and check it appears on the **Kitchen display**.

If your website address changes, reprint the codes.
[[SUGGEST]] Get ready for my first order | Take a payment | Set up my branding`,
  },
  {
    keys: ["My restaurant pages aren't loading or show errors. What should I check?", 'Restaurant not loading'],
    answer: `Check these in order:
1. **Refresh** the page and make sure you're signed in at **/r/your-restaurant/login**.
2. **Paused database** — Supabase's free tier pauses a project after about a week without use. Open supabase.com → your project → **Restore**, then refresh after a couple of minutes.
3. **Permission messages** — "Signed in as …" means the wrong login is active. Sign out and back in.
4. Still broken → **contact support** with your restaurant name and a screenshot of the error.
[[SUGGEST]] I get a permission error | How do I contact support? | Test a portal safely`,
  },
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const INDEX = new Map<string, string>();
for (const e of E) for (const k of e.keys) INDEX.set(norm(k), e.answer);

/** The pre-written answer for a recommended question, if there is one. */
export function instantAnswer(question: string): string | null {
  return INDEX.get(norm(question)) ?? null;
}

const STOP = new Set(
  'a an the i my me we our you your is are do does did how what why when where which who can to of in on for and or it this that with be will from at as by if not'.split(' '),
);
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));

/**
 * Closest pre-written answer for a free-typed question — used only when the
 * AI provider is unavailable, so the user still gets something relevant.
 */
export function closestAnswer(question: string): string | null {
  const q = words(question);
  if (q.size === 0) return null;
  let best: { score: number; answer: string } | null = null;
  for (const e of E) {
    for (const k of e.keys) {
      const kw = words(k);
      let hit = 0;
      for (const w of q) if (kw.has(w)) hit++;
      const score = hit / Math.max(2, Math.min(q.size, kw.size));
      if (hit >= 2 && (!best || score > best.score)) best = { score, answer: e.answer };
    }
  }
  return best && best.score >= 0.5 ? best.answer : null;
}
