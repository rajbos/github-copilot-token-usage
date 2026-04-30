// Settings for the AI Engineering Fluency JetBrains plugin.
//
// Uses the IntelliJ Platform Gradle plugin (v2) plugin-management block so
// the build script can apply `org.jetbrains.intellij.platform` without
// needing it on the classpath manually.

pluginManagement {
    repositories {
        gradlePluginPortal()
    }
}

plugins {
    // Foojay resolver lets Gradle auto-provision a matching JDK if the local
    // toolchain doesn't satisfy the version requested in build.gradle.kts.
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.8.0"
}

rootProject.name = "ai-engineering-fluency"
