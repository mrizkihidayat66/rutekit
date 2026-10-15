import { lazy } from 'react';
import { Route, Routes } from 'react-router';

import { NotFoundPage } from '@web/routes/NotFoundPage.tsx';
import { AppShell } from '@web/shell/AppShell.tsx';
import { AuthGate } from '@web/shell/AuthGate.tsx';

/**
 * Every page is a separate chunk (RULESET R6.3). The shell itself stays eager:
 * it is the frame, and making the user wait on it would defeat the point of the
 * route-level Suspense fallback inside it.
 */
const DesignShowcase = lazy(() =>
  import('@web/routes/dev/DesignShowcase.tsx').then((module) => ({
    default: module.DesignShowcase,
  })),
);

const DashboardPage = lazy(() =>
  import('@web/routes/pages/DashboardPage.tsx').then((module) => ({
    default: module.DashboardPage,
  })),
);
const UsageMetricsPage = lazy(() =>
  import('@web/routes/pages/UsageMetricsPage.tsx').then((module) => ({
    default: module.UsageMetricsPage,
  })),
);
const ConsoleLogPage = lazy(() =>
  import('@web/routes/pages/ConsoleLogPage.tsx').then((module) => ({
    default: module.ConsoleLogPage,
  })),
);
const ProviderCatalogPage = lazy(() =>
  import('@web/routes/pages/ProviderCatalogPage.tsx').then((module) => ({
    default: module.ProviderCatalogPage,
  })),
);
const ProviderDetailPage = lazy(() =>
  import('@web/routes/pages/ProviderDetailPage.tsx').then((module) => ({
    default: module.ProviderDetailPage,
  })),
);
const ModelCatalogPage = lazy(() =>
  import('@web/routes/pages/ModelCatalogPage.tsx').then((module) => ({
    default: module.ModelCatalogPage,
  })),
);
const AccountsPage = lazy(() =>
  import('@web/routes/pages/AccountsPage.tsx').then((module) => ({
    default: module.AccountsPage,
  })),
);
const QuotaPage = lazy(() =>
  import('@web/routes/pages/QuotaPage.tsx').then((module) => ({
    default: module.QuotaPage,
  })),
);
const CombosPage = lazy(() =>
  import('@web/routes/pages/CombosPage.tsx').then((module) => ({
    default: module.CombosPage,
  })),
);
const ModelMappingPage = lazy(() =>
  import('@web/routes/pages/ModelMappingPage.tsx').then((module) => ({
    default: module.ModelMappingPage,
  })),
);
const FilterRulesPage = lazy(() =>
  import('@web/routes/pages/FilterRulesPage.tsx').then((module) => ({
    default: module.FilterRulesPage,
  })),
);
const TokenSaverPage = lazy(() =>
  import('@web/routes/pages/TokenSaverPage.tsx').then((module) => ({
    default: module.TokenSaverPage,
  })),
);
const ApiKeysPage = lazy(() =>
  import('@web/routes/pages/ApiKeysPage.tsx').then((module) => ({
    default: module.ApiKeysPage,
  })),
);
const AutomationPage = lazy(() =>
  import('@web/routes/pages/AutomationPage.tsx').then((module) => ({
    default: module.AutomationPage,
  })),
);
const AutomationLogsPage = lazy(() =>
  import('@web/routes/pages/AutomationLogsPage.tsx').then((module) => ({
    default: module.AutomationLogsPage,
  })),
);
const ProxyPoolPage = lazy(() =>
  import('@web/routes/pages/ProxyPoolPage.tsx').then((module) => ({
    default: module.ProxyPoolPage,
  })),
);
const SmsProvidersPage = lazy(() =>
  import('@web/routes/pages/SmsProvidersPage.tsx').then((module) => ({
    default: module.SmsProvidersPage,
  })),
);
const ChatPage = lazy(() =>
  import('@web/routes/pages/ChatPage.tsx').then((module) => ({
    default: module.ChatPage,
  })),
);
const StudioPage = lazy(() =>
  import('@web/routes/pages/StudioPage.tsx').then((module) => ({
    default: module.StudioPage,
  })),
);
const BenchmarkPage = lazy(() =>
  import('@web/routes/pages/BenchmarkPage.tsx').then((module) => ({
    default: module.BenchmarkPage,
  })),
);
const VerificationPage = lazy(() =>
  import('@web/routes/pages/VerificationPage.tsx').then((module) => ({
    default: module.VerificationPage,
  })),
);
const ToolsPage = lazy(() =>
  import('@web/routes/pages/ToolsPage.tsx').then((module) => ({
    default: module.ToolsPage,
  })),
);
const CliToolsPage = lazy(() =>
  import('@web/routes/pages/CliToolsPage.tsx').then((module) => ({
    default: module.CliToolsPage,
  })),
);
const CustomizationPage = lazy(() =>
  import('@web/routes/pages/CustomizationPage.tsx').then((module) => ({
    default: module.CustomizationPage,
  })),
);
const SettingsPage = lazy(() =>
  import('@web/routes/pages/SettingsPage.tsx').then((module) => ({
    default: module.SettingsPage,
  })),
);
const LoginPage = lazy(() =>
  import('@web/routes/pages/LoginPage.tsx').then((module) => ({
    default: module.LoginPage,
  })),
);
const SetupPage = lazy(() =>
  import('@web/routes/pages/SetupPage.tsx').then((module) => ({
    default: module.SetupPage,
  })),
);

/**
 * The routing graph, mirroring the page table in PRD §5. `/dev/design` sits
 * outside the shell on purpose: it is an internal tool, not a product page.
 *
 * The two auth pages sit outside it for the opposite reason — they are the way
 * in, so the shell they would be shown inside does not exist yet. The gate wraps
 * both halves and is what keeps a signed-out visitor out of the console and a
 * signed-in one out of the wizard, rather than either page defending itself.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/dev/design" element={<DesignShowcase />} />

      <Route element={<AuthGate mode="guest" />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/setup" element={<SetupPage />} />
      </Route>

      <Route element={<AuthGate mode="session" />}>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="usage" element={<UsageMetricsPage />} />
          <Route path="console-log" element={<ConsoleLogPage />} />
          <Route path="providers" element={<ProviderCatalogPage />} />
          <Route path="providers/:id" element={<ProviderDetailPage />} />
          <Route path="models" element={<ModelCatalogPage />} />
          <Route path="accounts" element={<AccountsPage />} />
          <Route path="quota" element={<QuotaPage />} />
          <Route path="combos" element={<CombosPage />} />
          <Route path="model-mapping" element={<ModelMappingPage />} />
          <Route path="filter-rules" element={<FilterRulesPage />} />
          <Route path="token-saver" element={<TokenSaverPage />} />
          <Route path="api-keys" element={<ApiKeysPage />} />
          <Route path="automation" element={<AutomationPage />} />
          <Route path="automation/logs" element={<AutomationLogsPage />} />
          <Route path="proxy" element={<ProxyPoolPage />} />
          <Route path="sms-providers" element={<SmsProvidersPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="studio" element={<StudioPage />} />
          <Route path="benchmark" element={<BenchmarkPage />} />
          <Route path="verification" element={<VerificationPage />} />
          <Route path="tools" element={<ToolsPage />} />
          <Route path="cli-tools" element={<CliToolsPage />} />
          <Route path="customization" element={<CustomizationPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
