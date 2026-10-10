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
    answer: `Yes — with **Portals**. A portal is a login for a station or a person (e.g. "Counter 1", "Kitchen", "Attendance kiosk"). You tick exactly which permissions it has, and a **live preview** shows what it will see before you create it.

The **Staff** list itself is just names and jobs (for shifts and attendance) — adding someone there doesn't create a login.

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
2. Tick the permissions it needs — search, or filter by Read / Write / Approval / Export.
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
- **It's the right account** → that login doesn't have the permission. The owner can add it under **Portals → Edit access**.
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
    answer: `**Staff → Add staff**: type their name, their job (e.g. "Waiter", "Tandoor chef") and optionally a shift start time. No email or password is needed — the staff list is for shifts and attendance. You can also import a roster with **AI → Smart Import**.

To give someone a screen to work on, create a **Portal** for them (**Portals → Create Custom Portal**) and tick exactly what it can do. The portal's login is shown once when you create it.
[[SUGGEST]] Staff vs portals | Create a counter login | Test a portal safely`,
  },
  {
    keys: ['What is the difference between staff and portals?', 'Staff vs portals', 'Roles vs portals'],
    answer: `- **Staff** = the people who work for you: name, job and shift start. Used for shifts and attendance. No login.
- **Portal** = a login with exactly the permissions you tick (Counter 1, Kitchen screen, Attendance kiosk, or one person's own screen). Preview it before you create it.
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
- **Refund** — on a payment, click **refund**, then enter the amount and a reason. Refunds above your restaurant's limit (set under **Settings → Refund approvals**) need someone with refund approval.
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

  // ── Finance, taught step by step (numbers are the "example day" in ./knowledge.ts) ──
  {
    keys: ["Walk me through a day's money", 'Explain the finance model', 'How does the finance model work?', 'How does it track my money?'],
    answer: `Here's one **example day**, told as a story. Each step is written to the **ledger** automatically:
1. Table 4 pays **Rs 3,000 cash** → *Sales +3,000*, *Food cost +1,100* (from the recipes), *Payment +3,000*.
2. A takeaway pays **Rs 1,500 by card** → *Sales +1,500*, *Food cost +400*.
3. **Rs 500 refunded** for a wrong side dish → *Sales −500* (the food was still used, so food cost stays).
4. **Rs 200** taken from the till for ice → a *cash pay-out*, with a reason.
5. The **Rs 800 gas bill** is submitted, approved, then paid → *Expense +800* (counted once, on approval).
6. A **Rs 5,000** tomato invoice matches the order and delivery, is approved, then paid → *Payable +5,000*, then *−5,000*.
7. The till is counted and the **day is closed** (locked).

**Result:** sales 4,000 − food cost 1,500 − expenses 800 = **operating profit Rs 1,700**. Nothing is owed to suppliers, and the till should hold 5,000 float + 3,000 − 200 = **Rs 7,800**.
Where: **Finance → Finance overview**, and **Finance → Ledger** for every line.
[[SUGGEST]] What is the ledger? | How is my profit calculated? | How does day close work?`,
  },
  {
    keys: ['What is the ledger?', 'What is a ledger?', 'Explain the ledger'],
    answer: `**The ledger is your restaurant's money diary** — one line for every money event, in order, that can never be rubbed out. Think of it as a bank statement for the whole restaurant.

**Example:** in one day it might write:
- *Order completed* · Sales · **+Rs 3,000**
- *COGS recorded* · Food cost · **Rs 1,100**
- *Refund issued* · Sales · **−Rs 500**
- *Supplier invoice approved* · Payables · **+Rs 5,000**

Nobody types these — they're written the moment the sale, refund, expense or bill happens. Each line shows the business day, who did it and a link to where it came from. That's why the Finance overview, profit report and day close always agree: they all read this one diary.

**Where:** **Finance → Ledger**. Pick a period, click a category tile (Sales, Food cost, Expenses…) to see only those lines.
**Tip:** lines are never edited or deleted — a mistake is fixed with a correction.
[[SUGGEST]] How do I fix a wrong figure? | How is my profit calculated? | Walk me through a day's money`,
  },
  {
    keys: ['How is my profit calculated?', 'How is profit calculated?', 'What is operating profit?'],
    answer: `**Profit is what's left after paying for the food and the running costs.** Like a household budget: income, minus groceries, minus bills.

**Example day:**
1. **Sales** = 3,000 + 1,500 − 500 refund = **Rs 4,000**
2. **Food cost** (ingredients on the plates, from recipes) = **Rs 1,500**
3. **Gross profit** = 4,000 − 1,500 = **Rs 2,500**
4. **Operating expenses** (approved costs like gas, rent, salaries) = **Rs 800**
5. **Operating profit** = 2,500 − 800 = **Rs 1,700**

**Where:** **Finance → Finance overview** — pick Today, This month, Last 30 days…; each figure is compared with the previous period (▲ better / ▼ worse) and links to the ledger lines behind it.
**Tip:** an expense counts only once it's **approved**, and a supplier bill for stock isn't a cost until that food is sold.
[[SUGGEST]] What is food cost (COGS)? | Why doesn't a supplier bill cut profit? | What is the ledger?`,
  },
  {
    keys: ['What is food cost (COGS)?', 'What is food cost?', 'What is COGS?', 'What is food cost %?'],
    answer: `**Food cost (COGS — "cost of goods sold") is what the ingredients on the plate cost.** It's worked out from each dish's **recipe** at the moment it's sold.

**Example:** a Rs 3,000 table whose recipes add up to Rs 1,100, plus a Rs 1,500 takeaway costing Rs 400 → food cost **Rs 1,500**.
**Food cost %** = food cost ÷ sales = 1,500 ÷ 4,000 = **37.5%**. If your target is 30%, that's too high — prices may need to rise or portions to shrink.

**Where:** the **Finance overview** shows food cost % against your target (click *Target · change* to set it). **Food cost watch** lists dishes over target, or whose recipe cost went up in the last 30 days.
**Tip:** a dish with no linked recipe has no food cost — link recipes on the **Menu** so this figure is real.
[[SUGGEST]] How is my profit calculated? | Link dishes to ingredients | Why doesn't a supplier bill cut profit?`,
  },
  {
    keys: ["Why doesn't a supplier bill cut profit?", 'Why does buying stock not reduce profit?'],
    answer: `**Buying stock isn't a cost yet — using it is.** Like filling your fridge: the money has gone, but you haven't eaten anything yet.

**Example:** you buy **Rs 5,000** of tomatoes. That adds Rs 5,000 to **stock value** and Rs 5,000 to what you **owe the supplier**. Your profit doesn't move. When dishes with those tomatoes are sold, their share of the tomatoes becomes **food cost** on those sales.

So a big delivery day doesn't look like a loss, and a quiet day doesn't look like a fake profit.
**Where:** **Purchasing** for the bill; **Finance overview → Owed to suppliers** and **Supplier payables aging** for what's unpaid.
[[SUGGEST]] What is payables aging? | What is the 3-way match? | What is food cost (COGS)?`,
  },
  {
    keys: ['How does expense approval work?', 'How do expenses work?', 'How do I record an expense?'],
    answer: `**An expense goes through four steps, and it only counts as a cost once it's approved.** Like an office expense claim: you hand in the receipt, your manager signs it, then accounts pays it.

**Example — the Rs 800 gas bill:**
1. **Record** it on **Expenses** (category, amount, date, receipt photo) → *submitted*. Not a cost yet.
2. **Approve** → now it's a Rs 800 operating cost on its expense date.
3. **Pay** (cash / bank / card, with a reference) → *paid*. Still counted once, not twice.
Or **reject** it with a reason.

**Who:** recording, approving and paying are three separate permissions, so one person can't push money out alone.
**Tip:** the **Finance overview** shows "expenses awaiting approval" under **Needs attention**.
[[SUGGEST]] Who can approve and pay? | How is my profit calculated? | What is the ledger?`,
  },
  {
    keys: ['What is the 3-way match?', 'What is 3-way matching?', 'How does invoice matching work?'],
    answer: `**The 3-way match checks a supplier's bill before you pay it** by comparing three papers:
1. **Purchase order** — what you ordered
2. **Goods received** — what actually arrived
3. **Invoice** — what they're charging

**Example:** ordered 25 kg tomatoes at Rs 200, received 25 kg, invoiced 25 kg × Rs 200 = Rs 5,000 → **Matched** ✓.
If they billed 30 kg, or Rs 220/kg, the invoice goes **On hold** with the reason ("quantity", "price", "missing delivery"…) until someone sorts it out.

Then: matched → **approved** (now you owe it) → **paid**.
**Where:** **Purchasing** → open the invoice → **Details**. You can also **✨ Read an invoice with AI** from a PDF or photo — a person always checks and applies it.
**Who:** approving needs **Approve invoices**; paying needs **Record supplier payment** — different permissions.
[[SUGGEST]] What is payables aging? | Who can approve and pay? | Why doesn't a supplier bill cut profit?`,
  },
  {
    keys: ['What is payables aging?', 'What do I owe suppliers?'],
    answer: `**Payables aging shows what you owe suppliers, sorted by how late it is.** Like a pile of unpaid bills sorted into "not due yet", "a bit late" and "very late".

The columns: **Not yet due · 1–30 days · 31–60 · 61–90 · 90+ days overdue**, one row per supplier.
**Example:** a Rs 20,000 invoice due 15 days ago sits in **1–30 days**; one due 120 days ago sits in **90+**. A paid invoice disappears.

Only **approved** invoices are owed. One still on hold isn't payable yet.
**Where:** **Finance → Finance overview → Supplier payables aging**; the **Owed to suppliers** tile shows the total and how much is overdue.
[[SUGGEST]] What is the 3-way match? | How is my profit calculated? | Walk me through a day's money`,
  },
  {
    keys: ['How does day close work?', 'How do I close the day?', 'What is a cash variance?'],
    answer: `**Day close is your end-of-day check that the till and the records agree — then the day is locked.**

**Example:** the till opened with a **Rs 5,000** float, took **Rs 3,000** cash and paid **Rs 200** for ice:
expected cash = 5,000 + 3,000 − 200 = **Rs 7,800**.
1. Open **Day close** — the preview shows sales, payments by method, expected cash and any problems.
2. Record any **cash movements** you missed (pay-in, pay-out, bank drop) — each needs a reason.
3. **Count the till** and enter it. If you counted Rs 7,700, the **Rs 100 short** (the variance) needs a written reason.
4. **Close the day.** Nothing new can be dated to it (refunds still work). Reopening needs its own permission and a reason.

**Tip:** the Finance overview lists recent days with sales that aren't closed yet.
[[SUGGEST]] What is the ledger? | Who can approve and pay? | Walk me through a day's money`,
  },
  {
    keys: ['How do I fix a wrong figure?', 'How do I correct the ledger?', 'Can I edit the ledger?'],
    answer: `**You never edit the ledger — you add a correction.** Like a bank: it never deletes a wrong charge, it adds a refund line, so the history stays honest.

**Example:** a Rs 3,000 cash sale was recorded twice. Post a correction to **Sales**, **Decrease (−)**, **Rs 3,000**, for that business day, with the reason "Cash sale recorded twice". Sales go back to the right figure and both lines stay visible.

**Where:** **Finance → Ledger → + Post a correction** (category, increase/decrease, amount, business day, required reason). It's also written to the **Audit log**.
**Who:** only someone with **Adjust ledger**.
**Tip:** first fix the real record if you can (void the order, reject the expense) — the ledger corrects itself automatically. Use a correction only for what can't be fixed at the source.
[[SUGGEST]] What is the ledger? | Who can approve and pay? | How is my profit calculated?`,
  },
  {
    keys: ['Who can approve and pay?', 'What is separation of duties?', 'Which finance permissions are there?'],
    answer: `**Different people record, approve and pay, so no one can send money out alone.** Like a cheque that needs two signatures.

- Record / edit an expense → **Create / Update expense**
- Approve or reject an expense → **Approve expense**
- Pay an expense → **Pay expense**
- Approve or reject a supplier invoice → **Approve invoices** (Manage payables alone can't)
- Pay a supplier → **Record supplier payment**
- Till pay-ins / pay-outs → **Manage cash**
- Close / reopen a day → **Close day** / **Reopen day**
- Correct the ledger → **Adjust ledger**

The owner has all of them. Give each portal only what that job needs: **Portals → Edit access**. Every check is enforced by the database, and the AI never approves or pays anything.
[[SUGGEST]] Create a counter login | How does expense approval work? | What is the 3-way match?`,
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
