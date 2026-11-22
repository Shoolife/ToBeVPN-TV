package com.tobevpn.tv.presentation.navigation

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.toRoute
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import com.tobevpn.tv.domain.model.AuthState
import com.tobevpn.tv.presentation.appfilter.AppFilterScreen
import com.tobevpn.tv.presentation.devices.DevicesScreen
import com.tobevpn.tv.presentation.main.MainScreen
import com.tobevpn.tv.presentation.onboarding.MobileAppInstallScreen
import com.tobevpn.tv.presentation.onboarding.OnboardingScreen
import com.tobevpn.tv.presentation.pairing.PairingScreen
import com.tobevpn.tv.presentation.referrals.ReferralsScreen
import com.tobevpn.tv.presentation.promocodes.PromocodesScreen
import com.tobevpn.tv.presentation.servers.ServerListScreen
import com.tobevpn.tv.presentation.settings.SettingsScreen
import com.tobevpn.tv.presentation.settings.AboutScreen
import com.tobevpn.tv.presentation.settings.SupportScreen
import com.tobevpn.tv.presentation.speedtest.SpeedTestScreen
import com.tobevpn.tv.presentation.speedtest.SpeedTestHistoryScreen
import com.tobevpn.tv.presentation.stats.StatsScreen
import com.tobevpn.tv.presentation.subscription.SubscriptionScreen

@Composable
fun AppNavHost(
    navController: NavHostController,
    modifier: Modifier = Modifier,
    startFromOnboarding: Boolean = false,
    startAuthenticated: Boolean = false,
    onScreenBackActivated: () -> Unit = {},
) {
    val sessionViewModel: AppSessionViewModel = hiltViewModel()
    val authState by sessionViewModel.authState.collectAsStateWithLifecycle()
    var wasAuthenticated by remember(startAuthenticated) { mutableStateOf(startAuthenticated) }

    LaunchedEffect(authState) {
        when (authState) {
            is AuthState.Authenticated -> {
                if (!wasAuthenticated) {
                    navController.navigate(MainRoute) {
                        popUpTo<PairingRoute> { inclusive = true }
                        launchSingleTop = true
                    }
                }
                wasAuthenticated = true
            }
            AuthState.Unauthenticated -> {
                if (wasAuthenticated) {
                    navController.navigate(PairingRoute()) {
                        popUpTo(MainRoute) { inclusive = true }
                        launchSingleTop = true
                    }
                }
            }
            null -> Unit
        }
    }

    val startDestination: Any = when {
        startFromOnboarding -> OnboardingRoute
        startAuthenticated -> MainRoute
        else -> PairingRoute()
    }

    val navAnim = tween<Float>(durationMillis = 320)
    val slideAnim = tween<androidx.compose.ui.unit.IntOffset>(durationMillis = 320)
    val navigateBackSafely: () -> Unit = {
        // An on-screen Back button can emit several clicks when OK/Enter is
        // held on some TV remotes. Never allow those repeats to remove the
        // graph root (Home for an authenticated session).
        onScreenBackActivated()
        if (navController.previousBackStackEntry != null) {
            navController.popBackStack()
        }
    }
    val navigateHomeSafely: () -> Unit = {
        onScreenBackActivated()
        while (navController.previousBackStackEntry != null) {
            if (!navController.popBackStack()) break
        }
    }
    NavHost(
        navController = navController,
        startDestination = startDestination,
        modifier = modifier,
        // Smooth slide + fade between screens (forward slides toward Start,
        // back navigation slides toward End), matching the phone client.
        enterTransition = {
            fadeIn(navAnim) + slideIntoContainer(
                AnimatedContentTransitionScope.SlideDirection.Start, slideAnim,
            )
        },
        exitTransition = {
            fadeOut(navAnim) + slideOutOfContainer(
                AnimatedContentTransitionScope.SlideDirection.Start, slideAnim,
            )
        },
        popEnterTransition = {
            fadeIn(navAnim) + slideIntoContainer(
                AnimatedContentTransitionScope.SlideDirection.End, slideAnim,
            )
        },
        popExitTransition = {
            fadeOut(navAnim) + slideOutOfContainer(
                AnimatedContentTransitionScope.SlideDirection.End, slideAnim,
            )
        },
        // Navigation 2.10 gave the predictive back its own animation (the
        // leaving screen shrinks). Keep the one every way back had before.
        predictivePopEnterTransition = {
            fadeIn(navAnim) + slideIntoContainer(
                AnimatedContentTransitionScope.SlideDirection.End, slideAnim,
            )
        },
        predictivePopExitTransition = {
            fadeOut(navAnim) + slideOutOfContainer(
                AnimatedContentTransitionScope.SlideDirection.End, slideAnim,
            )
        },
    ) {
        composable<OnboardingRoute> {
            OnboardingScreen(
                onComplete = {
                    navController.navigate(MobileAppInstallRoute) {
                        popUpTo(OnboardingRoute) { inclusive = true }
                        launchSingleTop = true
                    }
                },
            )
        }
        composable<MobileAppInstallRoute> {
            MobileAppInstallScreen(
                onContinue = { entry ->
                    navController.navigate(PairingRoute(entry.name)) {
                        popUpTo(MobileAppInstallRoute) { inclusive = true }
                        launchSingleTop = true
                    }
                },
            )
        }
        composable<PairingRoute> {
            PairingScreen(
                onBack = {
                    navController.navigate(MobileAppInstallRoute) {
                        popUpTo<PairingRoute> { inclusive = true }
                        launchSingleTop = true
                    }
                },
                onAuthenticated = {
                    navController.navigate(MainRoute) {
                        popUpTo<PairingRoute> { inclusive = true }
                    }
                },
            )
        }
        composable<MainRoute> {
            MainScreen(
                onNavigateToServers = { navController.navigate(ServerListRoute) },
                onNavigateToPairing = {
                    navController.navigate(PairingRoute()) {
                        popUpTo(MainRoute) { inclusive = true }
                    }
                },
                onNavigateToSubscription = { selectCurrentPlan ->
                    navController.navigate(SubscriptionRoute(selectCurrentPlan))
                },
                onNavigateToSettings = { navController.navigate(SettingsRoute) },
                onNavigateToStats = { navController.navigate(StatsRoute) },
                onNavigateToSpeedTest = { navController.navigate(SpeedTestRoute) },
            )
        }
        composable<ServerListRoute> {
            ServerListScreen(
                onBack = navigateBackSafely,
                onLongBack = navigateHomeSafely,
            )
        }
        composable<StatsRoute> {
            StatsScreen(
                onBack = navigateBackSafely,
                onLongBack = navigateHomeSafely,
            )
        }
        composable<SpeedTestRoute> {
            SpeedTestScreen(
                onBack = navigateBackSafely,
                onLongBack = navigateHomeSafely,
                onNavigateToHistory = { navController.navigate(SpeedTestHistoryRoute) },
            )
        }
        composable<SpeedTestHistoryRoute> {
            SpeedTestHistoryScreen(
                onBack = navigateBackSafely,
                onLongBack = navigateHomeSafely,
            )
        }
        composable<SubscriptionRoute> { backStackEntry ->
            val route = backStackEntry.toRoute<SubscriptionRoute>()
            SubscriptionScreen(
                onBack = navigateBackSafely,
                onLongBack = navigateHomeSafely,
                selectCurrentPlan = route.selectCurrentPlan,
            )
        }
        composable<SettingsRoute> {
            SettingsScreen(
                onBack = navigateBackSafely,
                onLongBack = navigateHomeSafely,
                onNavigateToDevices = { navController.navigate(DevicesRoute) },
                onNavigateToAppFilter = { navController.navigate(AppFilterRoute) },
                onNavigateToReferrals = { navController.navigate(ReferralsRoute) },
                onNavigateToPromocodes = { navController.navigate(PromocodesRoute) },
                onNavigateToSupport = { navController.navigate(SupportRoute) },
            )
        }
        composable<AppFilterRoute> {
            AppFilterScreen(
                onBack = navigateBackSafely,
                onLongBack = navigateHomeSafely,
            )
        }
        composable<DevicesRoute> {
            DevicesScreen(
                onBack = navigateBackSafely,
                onLongBack = navigateHomeSafely,
            )
        }
        composable<ReferralsRoute> {
            ReferralsScreen(
                onBack = navigateBackSafely,
                onLongBack = navigateHomeSafely,
            )
        }
        composable<PromocodesRoute> {
            PromocodesScreen(
                onBack = navigateBackSafely,
                onLongBack = navigateHomeSafely,
            )
        }
        composable<AboutRoute> {
            AboutScreen(
                onBack = navigateBackSafely,
                onLongBack = navigateHomeSafely,
            )
        }
        composable<SupportRoute> {
            SupportScreen(
                onBack = navigateBackSafely,
                onLongBack = navigateHomeSafely,
            )
        }
    }
}
