import { mealHandlers } from "@/lib/server/meal-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
type Context = { params: Promise<{ id: string; mealId: string }> };

export async function POST(request: Request, { params }: Context) {
  const { id, mealId } = await params;
  return mealHandlers.copy(request, id, mealId);
}
