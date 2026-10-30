import { createClient } from "@supabase/supabase-js";

export function getPrivateStorage() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET;

  if (!url || !secretKey || !bucket) return null;

  const projectUrl = new URL(url);
  const path = projectUrl.pathname.endsWith("/") ? projectUrl.pathname.slice(0, -1) : projectUrl.pathname;
  const storageUrl = path === "/rest/v1" ? projectUrl.origin : url;

  const client = createClient(storageUrl, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  return { client, bucket };
}
