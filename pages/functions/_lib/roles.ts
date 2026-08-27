// ============================================================
//  ROLES & CAPABILITIES  —  functions/_lib/roles.ts
// ============================================================
//
//  THE SINGLE SOURCE OF TRUTH for what each role may do.
//
//  Before this, the role vocabulary was written out separately in
//  admin-invites.ts, admin-team.ts, staff_account.py and
//  schema_audit.py, and those lists had already drifted apart.
//  Worse, most endpoints checked no role at all — a "viewer" could
//  read volunteer PII and publish articles to the public site.
//
//  ── WHY CAPABILITIES, NOT ROLE CHECKS ─────────────────────
//
//  Endpoints ask "may this person export volunteers?", never "is
//  this person an admin?". Adding a role then means one entry in
//  the table below rather than hunting for every `role === "..."`
//  comparison — which is exactly how a new role ends up
//  accidentally holding, or lacking, some power nobody intended.
//
//  ── WHY THE DATABASE ONLY HAS A LOOKUP TABLE ──────────────
//
//  staff_roles lists the valid role NAMES; capabilities live here
//  in code. The database catches a typo'd role from any source
//  (portal, break-glass script, a hand-edited row) while adding a
//  role stays an INSERT rather than a table rebuild — the previous
//  CHECK constraint made 'superadmin' unassignable and could only
//  be fixed by rebuilding the table.
//
//  If you add a role: add it to ROLE_CAPABILITIES here AND insert
//  it into staff_roles. The audit script checks the two agree.
//
// ============================================================

/** Every distinct thing the portal can do. */
export type Capability =
  // Volunteer records contain encrypted PII: names, emails, phones, ZIPs.
  | "volunteers:read"      // view the list and individual records
  | "volunteers:export"    // download CSV — data leaves the portal
  | "volunteers:write"     // add or amend a record (e.g. signed up at a door)
  // Articles publish to the public website.
  | "articles:read"
  | "articles:write"       // create and edit drafts
  | "articles:publish"     // make visible on alexandriasofiakis.com
  | "calendar:read"
  | "calendar:write"
  // The team directory: who works here.
  | "team:read"
  | "team:write"
  // Granting and revoking access itself.
  | "staff:manage";

export const ALL_CAPABILITIES: Capability[] = [
  "volunteers:read", "volunteers:export", "volunteers:write",
  "articles:read", "articles:write", "articles:publish",
  "calendar:read", "calendar:write",
  "team:read", "team:write",
  "staff:manage"
];

/**
 * Role definitions. `label` and `description` are shown in the portal
 * so the person granting access can see what they are handing over.
 */
export interface RoleDefinition {
  name:         string;
  label:        string;
  description:  string;
  capabilities: Capability[];
  /** Ordering in dropdowns: least to most powerful. */
  rank:         number;
}

export const ROLES: RoleDefinition[] = [
  {
    name: "viewer",
    label: "Viewer",
    description: "Read-only. Cannot see volunteer contact details.",
    rank: 10,
    capabilities: ["articles:read", "calendar:read", "team:read"]
  },
  {
    name: "communications",
    label: "Communications",
    description: "Writes and publishes articles. No access to volunteer contact details.",
    rank: 20,
    capabilities: [
      "articles:read", "articles:write", "articles:publish",
      "calendar:read", "team:read"
    ]
  },
  {
    name: "field",
    label: "Field",
    description:
      "Volunteer records and the events calendar. Can add volunteers signed up " +
      "at the door. Cannot publish to the website.",
    rank: 30,
    capabilities: [
      "volunteers:read", "volunteers:export", "volunteers:write",
      "calendar:read", "calendar:write",
      "articles:read", "team:read"
    ]
  },
  {
    name: "admin",
    label: "Admin",
    description: "Everything operational. Cannot invite staff or change roles.",
    rank: 40,
    capabilities: ALL_CAPABILITIES.filter(c => c !== "staff:manage")
  },
  {
    name: "superadmin",
    label: "Superadmin",
    description: "Everything, including inviting staff and changing roles.",
    rank: 50,
    capabilities: [...ALL_CAPABILITIES]
  }
];

export const ROLE_NAMES = ROLES.map(r => r.name);

const BY_NAME = new Map(ROLES.map(r => [r.name, r]));

/**
 * Does this role hold this capability?
 *
 * An unknown role gets NOTHING. A role that has been removed from the
 * code but still sits on an account must not silently inherit
 * permissions — failing closed means that person loses access and says
 * so, rather than quietly keeping powers nobody can see.
 */
export function can(role: string | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  const def = BY_NAME.get(role);
  if (!def) return false;
  return def.capabilities.includes(capability);
}

export function capabilitiesFor(role: string | null | undefined): Capability[] {
  if (!role) return [];
  return [...(BY_NAME.get(role)?.capabilities ?? [])];
}

export function roleDefinition(role: string): RoleDefinition | null {
  return BY_NAME.get(role) ?? null;
}

export function isValidRole(role: string): boolean {
  return BY_NAME.has(role);
}

/**
 * Standard refusal. Names the capability rather than the required role:
 * "you need volunteers:export" survives a role being renamed, and tells
 * whoever reads the log what was actually attempted.
 */
export function forbidden(capability: Capability, role: string): Response {
  const def = BY_NAME.get(role);
  const who = def ? def.label : role;
  return new Response(JSON.stringify({
    error: `Your role (${who}) does not allow this action.`,
    required_capability: capability
  }), {
    status: 403,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
