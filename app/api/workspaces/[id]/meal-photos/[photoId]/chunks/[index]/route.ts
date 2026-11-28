import { mealPhotoHandlers } from "@/lib/server/meal-photo-http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; photoId: string; index: string }> };

export async function PUT(request: Request, { params }: Context) {
  const { id, photoId, index } = await params;
  return mealPhotoHandlers.chunk(request, id, photoId, index);
}
