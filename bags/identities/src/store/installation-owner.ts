import type Database from "better-sqlite3";
import { generateUserToken } from "../tokens.js";

export interface InstallationOwnerRecord { actorId: number; name: string; boundAt: number }
export interface InstallationOwnerSelection { actorId: number; actorToken: string }

export class InstallationOwner {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {}

  current(): InstallationOwnerRecord | null {
    const owner = this.db.prepare(`SELECT a.id AS actorId, a.name, o.bound_at AS boundAt
      FROM installation_owner o JOIN actors a ON a.id = o.actor_id AND a.token = o.actor_token AND a.type = o.actor_type
      WHERE o.singleton = 1 AND a.type = 'user'`).get() as InstallationOwnerRecord | undefined;
    return owner ? Object.freeze(owner) : null;
  }

  provision(input: { actorId?: number; username: string }): InstallationOwnerRecord {
    if (input.actorId !== undefined && (!Number.isSafeInteger(input.actorId) || input.actorId <= 0)) throw new Error("Owner must be a positive user actor ID");
    return this.db.transaction(() => {
      const current = this.current();
      if (current) {
        if (input.actorId !== undefined && input.actorId !== current.actorId) throw new Error("Installation owner is already bound to another user");
        return current;
      }
      let user: { id: number; token: string } | undefined;
      if (input.actorId !== undefined) {
        user = this.db.prepare("SELECT id, token FROM actors WHERE id = ? AND type = 'user'").get(input.actorId) as typeof user;
        if (!user) throw new Error("Selected installation user is unavailable");
      } else {
        const users = this.db.prepare("SELECT id, token FROM actors WHERE type = 'user' LIMIT 2").all() as { id: number; token: string }[];
        if (users.length > 1) throw new Error("Multiple installation users exist; select one with barry setup --owner <actor-id>");
        user = users[0];
        if (!user) {
          if (typeof input.username !== "string" || !input.username.trim() || input.username.length > 256) throw new Error("A local username is required to provision the installation owner");
          user = this.db.prepare("INSERT INTO actors(token, type, name, username) VALUES (?, 'user', ?, ?) RETURNING id, token").get(generateUserToken(), input.username, input.username) as { id: number; token: string };
        }
      }
      return this.bind({ actorId: user.id, actorToken: user.token });
    }).immediate();
  }

  bind(selection: InstallationOwnerSelection): InstallationOwnerRecord {
    if (!Number.isSafeInteger(selection.actorId) || selection.actorId <= 0 || typeof selection.actorToken !== "string" || !selection.actorToken || selection.actorToken.length > 256) throw new Error("Invalid installation owner selection");
    return this.db.transaction(() => {
      const actor = this.db.prepare("SELECT id FROM actors WHERE id = ? AND token = ? AND type = 'user'").get(selection.actorId, selection.actorToken);
      if (!actor) throw new Error("Selected installation user is unavailable or changed");
      const bound = this.db.prepare("SELECT actor_id, actor_token FROM installation_owner WHERE singleton = 1").get() as { actor_id: number; actor_token: string } | undefined;
      if (bound && (bound.actor_id !== selection.actorId || bound.actor_token !== selection.actorToken)) throw new Error("Installation owner is already bound to another user");
      if (!bound) this.db.prepare("INSERT INTO installation_owner (singleton, actor_id, actor_token, bound_at) VALUES (1, ?, ?, ?)").run(selection.actorId, selection.actorToken, this.now());
      const owner = this.current();
      if (!owner) throw new Error("Installation owner binding is unavailable");
      return owner;
    }).immediate();
  }
}
