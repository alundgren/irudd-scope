/**
 * The agent-facing diagram language reference, shared by the edit prompt and any tool
 * that teaches a model to write diagrams. Keep it in step with the renderers.
 */
export const DIAGRAM_REFERENCE = `The first line is the kind, an optional argument, and an optional ": Title". Node names are their own labels; edges create nodes on demand. Tags go in [brackets] at the end of a node's part, after any | detail, never after an edge label. "Name | detail" adds a quieter second line.

flow right|down — boxes and arrows. Leave the direction out to let it pick what fits the section; give one only when people ask.
  A -> B: label        arrow with label. Chains: A -> B -> C. Fan-out: A -> B, C
  A --> B              dashed arrow. A <-> B two-way.
  Name | detail [key]  node line with detail. Tags: key, start, end, db, decision, muted, s1…s7
  group Cloud: API, DB  a labelled box around nodes
Example:
flow: Login
User [start] -> Web app -> Auth API: token
Auth API -> Users | Postgres [db]
group Backend: Auth API, Users

sequence — messages between participants, in order.
  A -> B: message      B --> A: reply      note A: text      == Section ==
Example:
sequence: Checkout
Client -> API: POST /orders
API -> Payments: charge
Payments --> API: ok
note API: retries 3 times

steps — a numbered process. Title | detail [done|now]
Example:
steps: Release
Freeze branch [done]
Run QA | two days [now]
Ship to stores

timeline — dated events. When: what | detail [now]
Example:
timeline: Q3
July: Beta | 50 users
Aug 15: Launch [now]
September: Review

checklist — action items. [x] item | owner, [ ] item
Example:
checklist: Actions
[ ] Draft the RFC | Maria
[x] Book the room | Sam

compare — options as cards. ## Option [key], then + pro, - con, = note. [key] marks the chosen or recommended one.
Example:
compare: Database
## Postgres [key]
+ team knows it
- needs ops work
## DynamoDB
+ managed
= cost unclear

metrics — numbers as cards. Label: value | note. A note starting with + or - shows as a change.
Example:
metrics: This week
Signups: 1,240 | +12% vs last week
Churn: 2.1% | -0.3 pts

tree — a hierarchy. Two spaces of indent per level; the first line is the root.
Example:
tree: Org
Platform
  Infra | 4 people
  Data
    Pipelines

wireframe desktop|mobile — a low-fi screen, one element per line. Indent lines under card, list, tabs, row, sidebar, modal, header, nav or footer to put them inside. Mobile draws a phone frame.
  nav: Brand | Link | Link      header: Title | subtitle      title: Text      text: Text
  field: Label | placeholder    search: placeholder           select: Label | value
  button: Label [primary]       toggle: Label [on|off]        checkbox: Label [x]      radio: Label [x]
  chips: a | b | c              image: caption                card: Title | detail
  list: Title, then item: text | meta lines     table: col | col, then | a | b | rows
  tabs: a | b | c (first is active)   row: (children side by side)   sidebar: (later lines sit beside it)
  modal: Title      footer: text      An empty text: or title: draws grey placeholder bars.
Example:
wireframe mobile: Sign in
header: Welcome back
field: Email | you@example.com
field: Password
checkbox: Remember me [x]
button: Sign in [primary]

state right|down — states and transitions. Leave the direction out to let it pick what fits.
  A -> B: event [guard]   [*] -> A start   A -> [*] end   A -> A: self loop
  A | detail   declares a state      note A: text
Example:
state: Order
[*] -> Draft
Draft -> Paid: pay [card ok]
Paid -> Shipped: ship
Shipped -> [*]
note Paid: refunds within 14 days

er — entities and relations.
  Entity: field pk, field fk, field type   a word after a field name is its type
  A 1--* B: label   ends: 1, *, 0..1, 0..*, 1..*
Example:
er: Shop
User: id pk, email text
Order: id pk, user_id fk, total money
User 1--* Order: places

board — columns of cards: kanban, retro, risk register. ## Column [s1…s7], then - card | owner [done|key|s1…s7]
Example:
board: Sprint
## To do
- Draft RFC | Maria
## Doing [s1]
- Payment flow | Sam [key]
## Done
- CI setup [done]

bars unit — horizontal bars in written order. The unit after "bars" is optional (%, ms, $, users). Label: number | note [s1…s7]
Example:
bars %: Conversion
Visit: 100
Sign up: 24 | after the redesign
Paid: 6

bars funnel — a funnel: centred stages that narrow, each with its share of the first stage. Use it for drop-off between steps.
Example:
bars funnel: Checkout
Visited cart: 1200
Entered address: 640
Paid: 410

class right|down — UML classes with name, attribute and method compartments. Leave the direction out to let it pick what fits.
  Name: +id: int, -email: string, +send(): void   a member with ( is a method; + public, - private, # protected
  Name <<interface>>   or Name [interface], Name [abstract], Name [enum]
  A <|-- B extends   A <|.. B implements   A *-- B composition   A o-- B aggregation   A --> B association   A ..> B dependency
  A "1" --> "*" B: label   multiplicities in quotes, label after the colon
Example:
class: Shop
Customer: +id: int, -email: string, +notify(msg: string): void
Order: +total: money, +pay(): bool
Payable [interface]: +pay(): bool
Customer "1" --> "*" Order: places
Payable <|.. Order
Order *-- LineItem

gantt — task bars on a date axis. ## Phase groups tasks. Task: start .. end [done|now|key|s1…s7]
  Dates: 2026-02-03, w6 or v6 (ISO week), Feb or mars (a month), Feb 15, Q2. End may be +3d or +2w after the start.
  Task: after Other, 2w   starts when Other ends      Name: 2026-03-01 [milestone]   a diamond
  today: 2026-02-20   draws a today line
Example:
gantt: Launch plan
today: 2026-02-18
## Build
Design: 2026-02-02 .. 2026-02-13 [done]
API: after Design, 2w [now]
App: after API, +10d
## Release
Beta: w11 .. w12
Launch: 2026-03-30 [milestone]

swimlane right|down — who does which step, one lane per role. Leave the direction out to let it pick what fits. Steps run in written order across all lanes, each with an arrow to the next.
  ## Lane or lane Name   starts a lane      - Step   or   Step | detail [decision|start|end]
  A -> B: label   your own arrows; a step with its own arrows gets no automatic one. [end] steps get none.
Example:
swimlane: Laptop request
## Requester
- Submit request [start]
## Manager
- Approve? [decision]
## IT
- Order laptop
- Hand over [end]
## Requester
- Revise request
Approve? -> Order laptop: yes
Approve? -> Revise request: no
Revise request -> Approve?`;
