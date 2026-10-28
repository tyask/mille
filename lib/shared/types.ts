export interface AppUser {
  id: string;
  email: string;
  name: string;
  imageUrl: string | null;
  isEnabled: boolean;
  isTest: boolean;
}
