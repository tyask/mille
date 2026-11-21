import { mealHandlers } from "@/lib/server/meal-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  return mealHandlers.search(request, (await params).id);
}
