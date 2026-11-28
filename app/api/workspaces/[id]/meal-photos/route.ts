import { mealPhotoHandlers } from "@/lib/server/meal-photo-http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  return mealPhotoHandlers.create(request, (await params).id);
}
