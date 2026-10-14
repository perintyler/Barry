import type { z } from "zod";

export interface Route {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  operationId: string;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  responses: Readonly<Record<number, z.ZodType | null>>;
  stream?: boolean;
  sensitive?: boolean;
}

export type RouteResponse<R extends Route> = R["responses"][keyof R["responses"]] extends infer S
  ? S extends z.ZodType ? z.output<S> : void : never;

export function route<const R extends Route>(declaration: R): R {
  return declaration;
}
