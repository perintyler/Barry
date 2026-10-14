import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function source(relative: string): ts.SourceFile {
  const url = new URL(relative, import.meta.url);
  return ts.createSourceFile(url.pathname, readFileSync(url, "utf8"), ts.ScriptTarget.Latest, true);
}
function declaration(file: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  const found = file.statements.find((statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === name);
  if (!found) throw new Error(`Missing protocol interface ${name}`);
  return found;
}
function property(owner: ts.InterfaceDeclaration, name: string): ts.PropertySignature {
  const found = owner.members.find((member): member is ts.PropertySignature => ts.isPropertySignature(member) && member.name.getText() === name);
  if (!found) throw new Error(`Missing protocol property ${name}`);
  return found;
}
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const protocol = readme.split("## App Protocol (v1)")[1]?.split("\n## ")[0];
if (!protocol) throw new Error("Missing App Protocol documentation");
const documented = (kind: string): string[] => Array.from(protocol.matchAll(new RegExp(`^\\| ${kind} \\| \\x60([^\\x60]+)\\x60 \\|`, "gm")), match => match[1]).sort();

describe("App Protocol documentation matches the implementation", () => {
  it("enumerates exactly the accepted WebSocket client message types", () => {
    const type = property(declaration(source("./websocket.ts"), "ClientMessage"), "type").type;
    if (!type || !ts.isUnionTypeNode(type)) throw new Error("Client message discriminant must be explicit");
    const names = type.types.map(member => {
      if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) throw new Error("Client message type must be a literal");
      return member.literal.text;
    }).sort();
    expect(documented("client")).toEqual(names);
  });
  it("enumerates the subscribed capability fields", () => {
    const type = property(declaration(source("./session-runtime.ts"), "WsMessage"), "capabilities").type;
    if (!type || !ts.isTypeLiteralNode(type)) throw new Error("Capability fields must be explicit");
    expect(documented("capability")).toEqual(type.members.map(member => member.name?.getText()).sort());
    expect(protocol).toContain("`permission_request`");
    expect(protocol).toContain("`ruling`");
  });
});
