// A route table, not a component module, so Fast Refresh does not apply here.
/* eslint-disable react-refresh/only-export-components */
import { lazy } from "react";
import type { RouteObject } from "react-router";
import { Layout } from "@/components/layout";
import { GuestOnly, RequireAdmin, RequireAuth } from "@/components/guards";
import HomeShell from "@/pages/HomeShell";
import SendPage from "@/pages/SendPage";
import RetrievePage from "@/pages/RetrievePage";
import NotFoundPage, { RouteError } from "@/pages/NotFoundPage";

// The home page loads eagerly; everything else is split into its own chunk.
const LoginPage = lazy(() => import("@/pages/LoginPage"));
const SignupPage = lazy(() => import("@/pages/SignupPage"));
const ForgotPasswordPage = lazy(() => import("@/pages/ForgotPasswordPage"));
const ResetPasswordPage = lazy(() => import("@/pages/ResetPasswordPage"));
const MySharesPage = lazy(() => import("@/pages/MySharesPage"));
const AccountPage = lazy(() => import("@/pages/AccountPage"));
const VerifyEmailPage = lazy(() => import("@/pages/VerifyEmailPage"));
const AdminPage = lazy(() => import("@/pages/AdminPage"));
const UnsubscribePage = lazy(() => import("@/pages/UnsubscribePage"));

export const routes: RouteObject[] = [
    {
        element: <Layout />,
        errorElement: <RouteError />,
        children: [
            {
                element: <HomeShell />,
                children: [
                    { index: true, element: <SendPage /> },
                    { path: "open", element: <RetrievePage /> },
                    { path: "s/:code", element: <RetrievePage /> },
                ],
            },
            {
                element: <GuestOnly />,
                children: [
                    { path: "login", element: <LoginPage /> },
                    { path: "signup", element: <SignupPage /> },
                ],
            },
            { path: "forgot-password", element: <ForgotPasswordPage /> },
            { path: "reset-password", element: <ResetPasswordPage /> },
            { path: "unsubscribe", element: <UnsubscribePage /> },
            {
                element: <RequireAuth />,
                children: [
                    { path: "shares", element: <MySharesPage /> },
                    { path: "account", element: <AccountPage /> },
                    { path: "verify-email", element: <VerifyEmailPage /> },
                    {
                        element: <RequireAdmin />,
                        children: [{ path: "admin", element: <AdminPage /> }],
                    },
                ],
            },
            { path: "*", element: <NotFoundPage /> },
        ],
    },
];
