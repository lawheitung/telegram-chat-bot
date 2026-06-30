// Food catalog query tool for the meal agent. Read-only SQL over the D1 `FOODDB` binding
// (a scraped FairPrice grocery catalog). Returns the top matches (default 5); the agent asks
// the user to clarify when results are ambiguous. Columns scraped as text, so numeric filters
// CAST to REAL to be safe.

import type { Env } from "./types";

// TODO: set to your actual D1 table name (e.g. "products").
const TABLE = "products";

export const FOOD_TOOLS = [
  {
    name: "search_food",
    description:
      "Search the user's grocery catalog (real products she can buy: name, brand, pack, price, " +
      "macros, nutrigrade, stock). Returns the top matches (default 5). Combine filters to narrow. " +
      "If results are ambiguous or too broad, ask the user to clarify (price, size, brand) rather than guessing.",
    input_schema: {
      type: "object" as const,
      properties: {
        name_contains: { type: "string", description: "Substring of the product name, e.g. 'tofu'" },
        category: { type: "string", description: "Exact category slug, e.g. 'rice-noodles-cooking-ingredients'" },
        brand: { type: "string", description: "Brand substring" },
        min_price: { type: "number", description: "Minimum price (SGD)" },
        max_price: { type: "number", description: "Maximum price (SGD)" },
        in_stock: { type: "boolean", description: "Only in-stock items" },
        min_protein_g: { type: "number", description: "Minimum protein per serving/100g" },
        max_sugar_g: { type: "number", description: "Maximum sugar per serving/100g" },
        nutrigrade: { type: "string", description: "Nutri-grade letter, e.g. 'A'" },
        limit: { type: "integer", description: "How many to return (default 5, max 10)" },
      },
      required: [],
    },
  },
];

export async function callFoodTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
): Promise<string> {
  if (name !== "search_food") return `Unknown tool: ${name}`;
  const a = args;
  const where: string[] = [];
  const binds: unknown[] = [];
  if (a.name_contains) {
    where.push("name LIKE ?");
    binds.push(`%${a.name_contains}%`);
  }
  if (a.category) {
    where.push("category = ?");
    binds.push(a.category);
  }
  if (a.brand) {
    where.push("brand LIKE ?");
    binds.push(`%${a.brand}%`);
  }
  if (a.min_price != null) {
    where.push("CAST(price AS REAL) >= ?");
    binds.push(Number(a.min_price));
  }
  if (a.max_price != null) {
    where.push("CAST(price AS REAL) <= ?");
    binds.push(Number(a.max_price));
  }
  if (a.in_stock) where.push("in_stock = 1");
  if (a.min_protein_g != null) {
    where.push("CAST(protein_g AS REAL) >= ?");
    binds.push(Number(a.min_protein_g));
  }
  if (a.max_sugar_g != null) {
    where.push("CAST(sugar_g AS REAL) <= ?");
    binds.push(Number(a.max_sugar_g));
  }
  if (a.nutrigrade) {
    where.push("nutrigrade = ?");
    binds.push(a.nutrigrade);
  }

  const limit = Math.min(Math.max(Number(a.limit ?? 5) || 5, 1), 10);
  const sql =
    `SELECT name, brand, pack_raw, price, in_stock, nutrigrade, energy_kcal, protein_g, carb_g, fat_g, sugar_g, sodium_mg, url FROM ${TABLE}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY CAST(price AS REAL) ASC LIMIT ?`;
  binds.push(limit);

  try {
    const { results } = await env.FOODDB.prepare(sql).bind(...binds).all();
    if (!results || results.length === 0) {
      return "No matching products. Relax a filter, or ask the user to clarify what they want.";
    }
    return JSON.stringify(results);
  } catch (e) {
    return `Food DB error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
