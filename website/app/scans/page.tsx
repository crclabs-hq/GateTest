import { redirect } from "next/navigation";

/**
 * The Hall of Scans was retired on 2026-09-10 (Craig: "we don't have hall of
 * scans anymore"). The measured, current numbers live on /precision; old links
 * and bookmarks land there instead of on a 404. The dated scan records that
 * used to render here remain in git history.
 */
export default function ScansRetired() {
  redirect("/precision");
}
