/**
 * The agent-facing diagram language reference, shared by the edit prompt and any tool
 * that teaches a model to write diagrams. Keep it in step with the renderers.
 */
export const DIAGRAM_REFERENCE = `The first line is the kind, an optional argument, and an optional ": Title". Node names are their own labels; edges create nodes on demand. Tags go in [brackets] at the end of a node's part, after any | detail, never after an edge label. "Name | detail" adds a quieter second line.

flow right|down — boxes and arrows.
  A -> B: label        arrow with label. Chains: A -> B -> C. Fan-out: A -> B, C
  A --> B              dashed arrow. A <-> B two-way.
  Name | detail [key]  node line with detail. Tags: key, start, end, db, decision, muted, s1…s7
  group Cloud: API, DB  a labelled box around nodes
Example:
flow right: Login
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
    Pipelines`;
