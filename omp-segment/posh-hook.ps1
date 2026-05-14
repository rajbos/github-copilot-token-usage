# oh-my-posh Pre-Prompt Hook (PowerShell)
#
# Alternative to the `cmd` approach: this hook runs the CLI before each prompt
# and stores the results in environment variables that your oh-my-posh segment reads.
#
# Use this if you prefer not to use the `{{ cmd "..." }}` template function,
# or if you want more control over formatting.
#
# HOW TO USE
# ----------
# 1. Add this function to your PowerShell profile ($PROFILE).
#    Open it with: notepad $PROFILE
#
# 2. Add the function below to your profile.
#
# 3. Add the environment-variable segment to your oh-my-posh theme (see README.md).
#
# 4. Reload your profile: . $PROFILE

function Set-PoshContext {
    # Only refresh every 15 minutes to keep prompt fast.
    $lastRun = if ($env:COPILOT_TOKEN_LAST_RUN) {
        try { [DateTime]::Parse($env:COPILOT_TOKEN_LAST_RUN) } catch { [DateTime]::MinValue }
    } else {
        [DateTime]::MinValue
    }

    if (([DateTime]::UtcNow - $lastRun).TotalMinutes -lt 15) { return }

    try {
        $data   = ai-engineering-fluency usage --json | ConvertFrom-Json
        $today  = [int]$data.today.tokens
        $days30 = [int]$data.last30Days.tokens

        function Format-Tokens([int]$n) {
            if ($n -ge 1000000) { return "{0:N1}M" -f ($n / 1000000) }
            if ($n -ge 1000)    { return "{0:N1}K" -f ($n / 1000) }
            return "$n"
        }

        $env:COPILOT_TOKENS_TODAY   = Format-Tokens $today
        $env:COPILOT_TOKENS_30D     = Format-Tokens $days30
        $env:COPILOT_TOKEN_LAST_RUN = [DateTime]::UtcNow.ToString("o")
    }
    catch {
        $env:COPILOT_TOKENS_TODAY = "?"
        $env:COPILOT_TOKENS_30D   = "?"
    }
}
