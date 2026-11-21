import { mealHandlers } from "@/lib/server/meal-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  return mealHandlers.list(request, (await params).id);
}

export async function POST(request: Request, { params }: Context) {
  return mealHandlers.create(request, (await params).id);
}
