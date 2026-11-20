import React from "react";
export const usePathname = () => "/tenants";
export const useRouter = () => ({ push: () => {}, replace: () => {} });
export const AdminGate = ({ children }: { children: React.ReactNode }) => (
  <>{children}</>
);
export const createBrowserAdminSupabase = () => ({
  auth: { signOut: async () => ({}) },
});
export default function Link({
  children,
  ...props
}: {
  children: React.ReactNode;
  href: string;
}) {
  return <a {...props}>{children}</a>;
}
