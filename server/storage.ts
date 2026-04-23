import { db } from "./db";
import { history, type InsertHistory, type HistoryItem } from "@shared/schema";
import { desc } from "drizzle-orm";

export interface IStorage {
  createHistory(item: InsertHistory): Promise<HistoryItem>;
  getHistory(): Promise<HistoryItem[]>;
}

export class DatabaseStorage implements IStorage {
  async createHistory(item: InsertHistory): Promise<HistoryItem> {
    const [newItem] = await db
      .insert(history)
      .values(item)
      .returning();
    return newItem;
  }

  async getHistory(): Promise<HistoryItem[]> {
    return await db
      .select()
      .from(history)
      .orderBy(desc(history.createdAt))
      .limit(50);
  }
}

export const storage = new DatabaseStorage();
