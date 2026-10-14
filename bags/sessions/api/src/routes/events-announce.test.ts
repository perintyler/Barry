/**
 * The announce path, asserted through the REAL bus registry.
 *
 * Mocking `publishToTopic` and checking it was called would pass even if the
 * router published to the wrong topic — the subscriber would still receive
 * nothing. These tests attach a fake socket to the actual registry and assert
 * on what it receives.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { eventsRouter, setEventPublisher } from "@barry-rocks/events-bag";
import { setDb, closeDb } from "@barry-rocks/events-bag";
import { createEvent } from "@barry-rocks/events-bag";
import { setInProcessPublisher } from "@barry-rocks/sdk/events";
import {
  subscribeTopic,
  publishToTopic,
  resetTopics,
  type BusSocket,
} from "../bus-registry.js";

function fakeSocket(): BusSocket & { received: string[] } {
  const received: string[] = [];
  return {
    readyState: 1,
    bufferedAmount: 0,
    send(data: string) {
      received.push(data);
    },
    received,
  };
}

function announceOnBus(eventId: string): number {
  return publishToTopic("events", { type: "bus", topic: "events", id: eventId, kind: "created" });
}

let server: Server;
let base: string;

beforeEach(async () => {
  resetTopics();
  setDb(new Database(":memory:"));
  setInProcessPublisher(null);
  setEventPublisher(announceOnBus);

  const app = express();
  app.use(express.json());
  app.use("/events", eventsRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  setInProcessPublisher(null);
  closeDb();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("POST /events/:id/announce", () => {
  it("delivers the signal to a real subscriber", async () => {
    const socket = fakeSocket();
    subscribeTopic(socket, "events");

    const event = await createEvent({ type: "notification", source: "cli", title: "from a job" });
    const res = await fetch(`${base}/events/${event.id}/announce`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: 1 });

    expect(socket.received).toHaveLength(1);
    expect(JSON.parse(socket.received[0])).toEqual({
      type: "bus",
      topic: "events",
      id: event.id,
      kind: "created",
    });
  });

  /** A subscriber to another topic must not receive event traffic. */
  it("does not deliver to subscribers of a different topic", async () => {
    const other = fakeSocket();
    subscribeTopic(other, "identities");

    const event = await createEvent({ type: "progress", source: "cli", title: "x" });
    const res = await fetch(`${base}/events/${event.id}/announce`, { method: "POST" });

    expect((await res.json()).queued).toBe(0);
    expect(other.received).toHaveLength(0);
  });

  /** An id that was never written must not put a phantom on the bus. */
  it("404s an unknown event without publishing", async () => {
    const socket = fakeSocket();
    subscribeTopic(socket, "events");

    const res = await fetch(`${base}/events/evt_never_written/announce`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(socket.received).toHaveLength(0);
  });

  it("reports the real subscriber count, not a boolean", async () => {
    for (let i = 0; i < 3; i++) subscribeTopic(fakeSocket(), "events");
    const event = await createEvent({ type: "progress", source: "cli", title: "x" });
    const res = await fetch(`${base}/events/${event.id}/announce`, { method: "POST" });
    expect((await res.json()).queued).toBe(3);
  });

  /**
   * The whole point of this path: an event written by a process that is not
   * the API still reaches subscribers. Creating the event with no in-process
   * publisher set is exactly what `barry events emit` does.
   */
  it("carries an event created outside the API to a subscriber", async () => {
    const socket = fakeSocket();
    subscribeTopic(socket, "events");

    // No in-process publisher — as in a one-shot CLI process.
    const event = await createEvent({ type: "notification", source: "cli", title: "emitted" });
    expect(socket.received).toHaveLength(0); // nothing yet: different process

    await fetch(`${base}/events/${event.id}/announce`, { method: "POST" });
    expect(JSON.parse(socket.received[0]).id).toBe(event.id);
  });
});
