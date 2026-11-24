import { mealHandlers } from "@/lib/server/meal-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
type Context = { params: Promise<{ id: string; suggestionId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { id, suggestionId } = await params;
  return mealHandlers.getSuggestion(request, id, suggestionId);
}
