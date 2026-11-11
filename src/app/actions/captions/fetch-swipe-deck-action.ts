"use server";

import { createClient } from "@/utils/supabase/server";

export type SwipeCaption = {
  id: string;
  content: string;
  image_id: string;
  image_url: string;
  like_count: number;
  is_saved: boolean;
};

/**
 * Builds the card stack for swipe mode.
 * Starts from the most liked public captions and skips any caption the
 * signed-in user has already voted on, so every card is a new one for them.
 */
export const fetchSwipeDeckAction = async (
  deckSize = 50
): Promise<SwipeCaption[]> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return [];
  }

  const { data: captions, error } = await supabase
    .from("captions")
    .select(
      `
      id,
      content,
      image_id,
      like_count,
      images!inner (
        url,
        is_public
      )
    `
    )
    .eq("is_public", true)
    .eq("images.is_public", true)
    .gt("like_count", 0)
    .order("like_count", { ascending: false })
    .limit(300);

  if (error) {
    console.error("Error fetching swipe deck:", error);
    throw new Error("Failed to load captions");
  }

  type Row = {
    id: string;
    content: string | null;
    image_id: string | null;
    like_count: number | null;
    images?: { url?: string | null } | null;
  };

  const rows = ((captions ?? []) as unknown as Row[]).filter(
    (row) => row.content && row.images?.url
  );
  const ids = rows.map((row) => row.id);

  if (ids.length === 0) {
    return [];
  }

  const [{ data: votes }, { data: saves }] = await Promise.all([
    supabase
      .from("caption_votes")
      .select("caption_id")
      .eq("profile_id", user.id)
      .in("caption_id", ids),
    supabase
      .from("caption_saves")
      .select("caption_id")
      .eq("profile_id", user.id)
      .in("caption_id", ids),
  ]);

  const voted = new Set((votes ?? []).map((v) => v.caption_id));
  const saved = new Set((saves ?? []).map((s) => s.caption_id));

  return rows
    .filter((row) => !voted.has(row.id))
    .slice(0, deckSize)
    .map((row) => ({
      id: row.id,
      content: row.content ?? "",
      image_id: row.image_id ?? "",
      image_url: row.images?.url ?? "",
      like_count: row.like_count ?? 0,
      is_saved: saved.has(row.id),
    }));
};
