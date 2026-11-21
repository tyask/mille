import { mealHandlers } from "@/lib/server/meal-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
type Context = { params: Promise<{ id: string; mealId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { id, mealId } = await params;
  return mealHandlers.get(request, id, mealId);
}

export async function PUT(request: Request, { params }: Context) {
  const { id, mealId } = await params;
  return mealHandlers.update(request, id, mealId);
}

export async function DELETE(request: Request, { params }: Context) {
  const { id, mealId } = await params;
  return mealHandlers.remove(request, id, mealId);
}
