import { redirect } from "next/navigation";

export default function LibraryPage() {
  redirect("/workspace?tab=artifacts");
}
