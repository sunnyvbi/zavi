import React from "react";
import { createRoot } from "react-dom/client";
import { TenantsGrowthView } from "@/components/admin/TenantsGrowthView";
import Layout from "@/app/(dashboard)/layout";
createRoot(document.getElementById("root")!).render(
  <Layout>
    <TenantsGrowthView />
  </Layout>,
);
