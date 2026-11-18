// The Syok Code add-on for JetBrains editors (IntelliJ IDEA, PyCharm, WebStorm, GoLand and the others).
// It is small on purpose: it opens the editor's own terminal and starts the syok program there, the same way the
// VS Code add-on does. Everything that can be tested without an editor is in SyokLogic and has tests.
import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("java")
    id("org.jetbrains.intellij.platform") version "2.20.1"
}

group = "com.syokai"
version = "0.17.0"

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.3.6")
        bundledPlugin("org.jetbrains.plugins.terminal")
        pluginVerifier()
        testFramework(TestFrameworkType.Platform)
    }
    testImplementation("junit:junit:4.13.2")
}

intellijPlatform {
    buildSearchableOptions = false
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "243"
            untilBuild = provider { null } // no upper limit: the verifier below is what says where it works
        }
    }
    pluginVerification {
        ides {
            ide(IntelliJPlatformType.IntellijIdeaCommunity, "2024.3.6")
            ide(IntelliJPlatformType.IntellijIdeaCommunity, "2025.2.4")
        }
    }
}

tasks.test { useJUnit() }
