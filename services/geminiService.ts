
import { GoogleGenAI, Type } from "@google/genai";
import { Paper, DigestSummary } from "../types";

// Initialize the Gemini API client using the API key from environment variables exclusively
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const processScholarEmails = async (
  rawEmails: string,
  keywords: string[]
): Promise<{ papers: Paper[], summary: DigestSummary }> => {
  // Use gemini-3-pro-preview for complex text tasks requiring high reasoning capabilities
  const model = 'gemini-3-pro-preview';
  
  const prompt = `
    Analyze the following raw content from Google Scholar alert emails. 
    1. Extract all academic papers mentioned.
    2. For each paper, identify: title, authors, snippet/description, and link.
    3. Filter and score these papers based on their relevance to these keywords: ${keywords.join(", ")}.
    4. Generate a cohesive summary of the research trends found in these emails.

    Content:
    ${rawEmails}
  `;

  // Define a comprehensive response schema to ensure structured data matches the Paper and DigestSummary types
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      // Remove thinkingBudget: 0 to allow the model to reason through complex academic abstracts
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          papers: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING, description: "A unique identifier for the paper" },
                title: { type: Type.STRING },
                authors: { type: Type.ARRAY, items: { type: Type.STRING } },
                snippet: { type: Type.STRING },
                link: { type: Type.STRING },
                source: { type: Type.STRING, description: "The origin of the alert, e.g., 'Google Scholar Alert'" },
                date: { type: Type.STRING },
                relevanceScore: { type: Type.NUMBER, description: "Relevance percentage from 0 to 100" },
                matchedKeywords: { type: Type.ARRAY, items: { type: Type.STRING } }
              },
              required: ["id", "title", "authors", "snippet", "link", "source", "date", "relevanceScore", "matchedKeywords"],
              propertyOrdering: ["id", "title", "authors", "snippet", "link", "source", "date", "relevanceScore", "matchedKeywords"]
            }
          },
          summary: {
            type: Type.OBJECT,
            properties: {
              overview: { type: Type.STRING },
              keyTrends: { type: Type.ARRAY, items: { type: Type.STRING } },
              topRecommendations: { type: Type.ARRAY, items: { type: Type.STRING } },
              categorizedPapers: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    keyword: { type: Type.STRING },
                    paperIds: { type: Type.ARRAY, items: { type: Type.STRING } }
                  }
                }
              }
            },
            required: ["overview", "keyTrends", "topRecommendations", "categorizedPapers"],
            propertyOrdering: ["overview", "keyTrends", "topRecommendations", "categorizedPapers"]
          }
        },
        required: ["papers", "summary"]
      }
    }
  });

  try {
    // Extract text output from response using the .text property (not a method)
    const jsonStr = response.text;
    if (!jsonStr) {
      throw new Error("Empty response received from the model.");
    }
    return JSON.parse(jsonStr.trim());
  } catch (error) {
    console.error("Failed to parse Gemini response:", error);
    throw new Error("The AI provided an invalid JSON format.");
  }
};
