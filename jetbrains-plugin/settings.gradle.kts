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
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

rootProject.name = "ai-engineering-fluency"

// Dependency locking for the settings plugins (settings-gradle.lockfile) and the
// build-script classpath, i.e. the Kotlin and IntelliJ Platform plugins
// (buildscript-gradle.lockfile). Regenerate with:
//   ./gradlew dependencies --write-locks
buildscript {
    configurations.classpath {
        resolutionStrategy.activateDependencyLocking()
    }
}

gradle.beforeProject {
    buildscript.configurations.named("classpath") {
        resolutionStrategy.activateDependencyLocking()
    }
}
