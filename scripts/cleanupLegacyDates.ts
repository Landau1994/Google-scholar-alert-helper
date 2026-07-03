import * as lancedb from "@lancedb/lancedb";
import path from "path";
import { normalizeDateString } from "../services/vectorService.ts";

const VECTOR_DB_PATH = path.resolve(process.cwd(), "data/vector_db");

async function main() {
  console.log("🧹 Starting database cleanup migration...");
  console.log(`📂 Connecting to LanceDB at: ${VECTOR_DB_PATH}`);
  
  const db = await lancedb.connect(VECTOR_DB_PATH);
  const tableNames = await db.tableNames();
  
  if (!tableNames.includes("papers")) {
    console.log("❌ Table 'papers' not found in database. Exiting...");
    process.exit(1);
  }
  
  const table = await db.openTable("papers");
  const allRecords = await table.query().toArray();
  
  console.log(`\n📊 Found ${allRecords.length} total records in 'papers' table.`);
  
  let modifiedCount = 0;
  const cleanedRecords = allRecords.map(p => {
    const originalDate = p.date;
    const cleanDate = p.id === "schema-definition" ? originalDate : normalizeDateString(originalDate, p.indexedAt);
    
    if (p.id !== "schema-definition" && originalDate !== cleanDate) {
      modifiedCount++;
      // Print first 10 corrections for visibility
      if (modifiedCount <= 10) {
        console.log(`   [Fix #${modifiedCount}] "${p.title.substring(0, 50)}..."`);
        console.log(`               "${originalDate}" ➔ "${cleanDate}" (Source: ${p.source}, indexedAt: ${p.indexedAt})`);
      }
    }
    
    // Convert Apache Arrow Vectors to clean native JS Arrays to prevent Type Inference failures
    return {
      id: p.id,
      title: p.title,
      authors: p.authors ? Array.from(p.authors) : [],
      snippet: p.snippet || "",
      link: p.link || "",
      source: p.source || "Unknown",
      date: cleanDate,
      relevanceScore: typeof p.relevanceScore === "number" ? p.relevanceScore : 0,
      matchedKeywords: p.matchedKeywords ? Array.from(p.matchedKeywords) : [],
      vector: p.vector ? Array.from(p.vector) : [],
      indexedAt: p.indexedAt || new Date().toISOString()
    };
  });
  
  console.log(`\n✨ Total records requiring correction: ${modifiedCount}/${allRecords.length - 1}`);
  
  console.log("\n💾 Saving cleaned records back to LanceDB using overwrite mode...");
  await db.createTable("papers", cleanedRecords, { mode: "overwrite" });
  console.log("🎉 Successfully cleaned up legacy dates and saved to vector database!");
}

main().catch(error => {
  console.error("❌ Migration failed with error:", error);
  process.exit(1);
});
