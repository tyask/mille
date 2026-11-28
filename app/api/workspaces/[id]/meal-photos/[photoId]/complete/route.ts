import { mealPhotoHandlers } from "@/lib/server/meal-photo-http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; photoId: string }> };

export async function POST(request: Request, { params }: Context) {
  const { id, photoId } = await params;
  return mealPhotoHandlers.complete(request, id, photoId);
}
