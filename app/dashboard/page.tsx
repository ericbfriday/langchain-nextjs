"use client";

import { useAuth } from "@/components/auth/auth-provider";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function DashboardPage() {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-lg">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              <h1 className="text-xl font-semibold">Dashboard</h1>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-gray-700">{user.email}</span>
              <button
                onClick={async () => {
                  await signOut();
                  router.push("/login");
                }}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-md hover:bg-red-700"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="px-4 py-5 sm:p-6">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">
                Welcome to your Dashboard
              </h2>
              
              <div className="space-y-4">
                <div className="bg-gray-50 p-4 rounded-md">
                  <h3 className="text-lg font-medium text-gray-900 mb-2">
                    User Information
                  </h3>
                  <dl className="space-y-2">
                    <div>
                      <dt className="text-sm font-medium text-gray-500">Email:</dt>
                      <dd className="text-sm text-gray-900">{user.email}</dd>
                    </div>
                    {user.name && (
                      <div>
                        <dt className="text-sm font-medium text-gray-500">Name:</dt>
                        <dd className="text-sm text-gray-900">{user.name}</dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-sm font-medium text-gray-500">User ID:</dt>
                      <dd className="text-sm text-gray-900 font-mono">{user.id}</dd>
                    </div>
                  </dl>
                </div>

                <div className="pt-4">
                  <h3 className="text-lg font-medium text-gray-900 mb-2">
                    Quick Actions
                  </h3>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <button className="p-4 border border-gray-200 rounded-lg hover:border-blue-500 hover:shadow-md transition-all">
                      <div className="text-left">
                        <h4 className="font-medium">Profile Settings</h4>
                        <p className="text-sm text-gray-500 mt-1">
                          Update your personal information
                        </p>
                      </div>
                    </button>
                    
                    <button className="p-4 border border-gray-200 rounded-lg hover:border-blue-500 hover:shadow-md transition-all">
                      <div className="text-left">
                        <h4 className="font-medium">Security</h4>
                        <p className="text-sm text-gray-500 mt-1">
                          Manage your password and security
                        </p>
                      </div>
                    </button>
                    
                    <button className="p-4 border border-gray-200 rounded-lg hover:border-blue-500 hover:shadow-md transition-all">
                      <div className="text-left">
                        <h4 className="font-medium">Preferences</h4>
                        <p className="text-sm text-gray-500 mt-1">
                          Customize your experience
                        </p>
                      </div>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}