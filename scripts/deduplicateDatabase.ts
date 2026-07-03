import * as lancedb from "@lancedb/lancedb";
import path from "path";

const VECTOR_DB_PATH = path.resolve(process.cwd(), "data/vector_db");

// Helper to normalize titles for precise duplicate grouping
function getNormalizedTitle(title: string): string {
  return (title || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "") // Remove punctuation
    .replace(/\s+/g, " ");   // Normalize whitespace
}

// Check if a source name is more specific than another
function isMoreSpecificSource(source1: string, source2: string): boolean {
  const genericSources = ["google scholar", "google scholar alert", "cell press", "aha journals", "unknown", "unknown source"];
  const s1 = source1.toLowerCase().trim();
  const s2 = source2.toLowerCase().trim();
  
  const s1IsGeneric = genericSources.some(g => s1.includes(g));
  const s2IsGeneric = genericSources.some(g => s2.includes(g));
  
  if (s1IsGeneric && !s2IsGeneric) return false;
  if (!s1IsGeneric && s2IsGeneric) return true;
  return source1.length >= source2.length;
}

async function main() {
  console.log("🧹 Starting database deduplication and metadata merging...");
  console.log(`📂 Connecting to LanceDB at: ${VECTOR_DB_PATH}`);
  
  const db = await lancedb.connect(VECTOR_DB_PATH);
  const tableNames = await db.tableNames();
  
  if (!tableNames.includes("papers")) {
    console.log("❌ Table 'papers' not found in database. Exiting...");
    process.exit(1);
  }
  
  const table = await db.openTable("papers");
  const allRecords = await table.query().toArray();
  
  console.log(`📊 Total records loaded: ${allRecords.length}`);
  
  // Group records by normalized title
  const groups = new Map<string, any[]>();
  const schemaRecord = allRecords.find(p => p.id === "schema-definition");
  
  for (const p of allRecords) {
    if (p.id === "schema-definition") continue;
    
    const normTitle = getNormalizedTitle(p.title);
    if (!groups.has(normTitle)) {
      groups.set(normTitle, []);
    }
    groups.get(normTitle)!.push(p);
  }
  
  const deduplicatedRecords: any[] = [];
  if (schemaRecord) {
    deduplicatedRecords.push({
      id: schemaRecord.id,
      title: schemaRecord.title,
      authors: schemaRecord.authors ? Array.from(schemaRecord.authors) : [],
      snippet: schemaRecord.snippet || "",
      link: schemaRecord.link || "",
      source: schemaRecord.source || "Unknown",
      date: schemaRecord.date || "2026-01-01",
      relevanceScore: typeof schemaRecord.relevanceScore === "number" ? schemaRecord.relevanceScore : 0,
      matchedKeywords: schemaRecord.matchedKeywords ? Array.from(schemaRecord.matchedKeywords) : [],
      vector: schemaRecord.vector ? Array.from(schemaRecord.vector) : [],
      indexedAt: schemaRecord.indexedAt || new Date().toISOString()
    });
  }
  
  let duplicateGroupsCount = 0;
  let totalMergedCount = 0;
  
  console.log("\n⚡ Merging Duplicate Records...");
  
  for (const [normTitle, group] of groups.entries()) {
    if (group.length === 1) {
      const p = group[0];
      deduplicatedRecords.push({
        id: p.id,
        title: p.title,
        authors: p.authors ? Array.from(p.authors) : [],
        snippet: p.snippet || "",
        link: p.link || "",
        source: p.source || "Unknown",
        date: p.date,
        relevanceScore: typeof p.relevanceScore === "number" ? p.relevanceScore : 0,
        matchedKeywords: p.matchedKeywords ? Array.from(p.matchedKeywords) : [],
        vector: p.vector ? Array.from(p.vector) : [],
        indexedAt: p.indexedAt
      });
      continue;
    }
    
    // We have a duplicate group! Merge them intelligently.
    duplicateGroupsCount++;
    totalMergedCount += (group.length - 1);
    
    // Choose the best of each field across all duplicates
    let bestId = group[0].id;
    let bestTitle = group[0].title;
    let bestAuthors: string[] = [];
    let bestSnippet = "";
    let bestLink = "";
    let bestSource = "";
    let bestDate = "";
    let bestScore = 0;
    const mergedKeywordsSet = new Set<string>();
    let bestVector = group[0].vector;
    let bestIndexedAt = group[0].indexedAt;
    
    // Simple heuristic to avoid using numeric short IDs if possible
    const isShortOrNumericId = (idStr: string) => /^\d+$/.test(idStr) || idStr.length <= 4;
    
    for (const p of group) {
      // 1. Title: pick the longest/most complete title
      if (!bestTitle || (p.title && p.title.length > bestTitle.length)) {
        bestTitle = p.title;
      }
      
      // 2. ID: prefer non-numeric, longer IDs
      if (isShortOrNumericId(bestId) && !isShortOrNumericId(p.id)) {
        bestId = p.id;
      }
      
      // 3. Authors: select the longest authors array
      const currentAuthors = p.authors ? Array.from(p.authors) as string[] : [];
      if (currentAuthors.length > bestAuthors.length) {
        bestAuthors = currentAuthors;
      }
      
      // 4. Snippet (Abstract): select the longest description
      if (!bestSnippet || (p.snippet && p.snippet.length > bestSnippet.length)) {
        bestSnippet = p.snippet;
      }
      
      // 5. Link: select the doi link or longest link
      if (!bestLink || (p.link && p.link.includes("doi.org")) || (p.link && p.link.length > bestLink.length)) {
        bestLink = p.link;
      }
      
      // 6. Source: select the most specific/prestigous source
      if (!bestSource || isMoreSpecificSource(p.source, bestSource)) {
        bestSource = p.source;
      }
      
      // 7. Date: select the newest/most complete YYYY-MM-DD date
      if (!bestDate || (p.date && p.date > bestDate)) {
        bestDate = p.date;
      }
      
      // 8. Relevance Score: select the highest score
      if (p.relevanceScore && p.relevanceScore > bestScore) {
        bestScore = p.relevanceScore;
      }
      
      // 9. Matched Keywords: union of all matched keywords
      if (p.matchedKeywords) {
        Array.from(p.matchedKeywords).forEach((k: any) => mergedKeywordsSet.add(k));
      }
      
      // 10. Vector: select the first non-empty vector
      if ((!bestVector || bestVector.length === 0) && p.vector && p.vector.length > 0) {
        bestVector = p.vector;
      }
      
      // 11. IndexedAt: select the oldest indexedAt timestamp (earliest creation)
      if (!bestIndexedAt || (p.indexedAt && p.indexedAt < bestIndexedAt)) {
        bestIndexedAt = p.indexedAt;
      }
    }
    
    // Print out the first 5 merges as examples
    if (duplicateGroupsCount <= 5) {
      console.log(`   [Merge #${duplicateGroupsCount}] "${bestTitle.substring(0, 55)}..."`);
      console.log(`         Merged ${group.length} records into one:`);
      group.forEach((p, idx) => {
        console.log(`            ${idx + 1}. ID: ${p.id} | Date: ${p.date} | Source: ${p.source} | Keywords: [${Array.from(p.matchedKeywords || []).join(", ")}]`);
      });
      console.log(`         ➔ Final Unified Record: Source: "${bestSource}" | Date: "${bestDate}" | Keywords: [${Array.from(mergedKeywordsSet).join(", ")}]`);
    }
    
    // Build the final optimized merged record
    deduplicatedRecords.push({
      id: bestId,
      title: bestTitle,
      authors: bestAuthors,
      snippet: bestSnippet || "",
      link: bestLink || "",
      source: bestSource || "Unknown",
      date: bestDate,
      relevanceScore: bestScore,
      matchedKeywords: Array.from(mergedKeywordsSet),
      vector: bestVector ? Array.from(bestVector) : [],
      indexedAt: bestIndexedAt
    });
  }
  
  console.log(`\n📈 Deduplication Statistics:`);
  console.log(`   - Duplicate title groups resolved: ${duplicateGroupsCount}`);
  console.log(`   - Redundant duplicate records removed: ${totalMergedCount}`);
  console.log(`   - Output records for database: ${deduplicatedRecords.length}`);
  
  console.log("\n💾 Saving deduplicated and merged records back to LanceDB...");
  await db.createTable("papers", deduplicatedRecords, { mode: "overwrite" });
  console.log("🎉 Successfully deduplicated and optimized your vector database!");
}

main().catch(error => {
  console.error("❌ Deduplication failed with error:", error);
  process.exit(1);
});
