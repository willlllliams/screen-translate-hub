Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$out = $args[0]
$s = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.DeviceName) primary=$($_.Primary) $($_.Bounds)" }
$sid = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save("$out\desk.png")
"session=$sid`n$($s -join "`n")`nvirtual=$b" | Out-File "$out\desk.txt" -Encoding utf8
