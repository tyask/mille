import { mealPhotoHandlers } from "@/lib/server/meal-photo-http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; photoId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { id, photoId } = await params;
  return mealPhotoHandlers.read(request, id, photoId);
}

export async function DELETE(request: Request, { params }: Context) {
  const { id, photoId } = await params;
  return mealPhotoHandlers.remove(request, id, photoId);
}
