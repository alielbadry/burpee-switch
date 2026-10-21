Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$iconDir = Join-Path $root "icons"
$sourcePath = Join-Path $iconDir "burpee-switch-master.png"

if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "Missing logo master: $sourcePath"
}

function New-RoundedRectPath {
    param([float]$X, [float]$Y, [float]$Width, [float]$Height, [float]$Radius)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $Radius * 2
    $path.AddArc($X, $Y, $d, $d, 180, 90)
    $path.AddArc($X + $Width - $d, $Y, $d, $d, 270, 90)
    $path.AddArc($X + $Width - $d, $Y + $Height - $d, $d, $d, 0, 90)
    $path.AddArc($X, $Y + $Height - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

$source = [System.Drawing.Image]::FromFile($sourcePath)
$crop = New-Object System.Drawing.Rectangle(340, 244, 520, 520)

try {
    foreach ($size in 16, 48, 128) {
        $scale = 4
        $largeSize = $size * $scale
        $large = New-Object System.Drawing.Bitmap($largeSize, $largeSize)
        $g = [System.Drawing.Graphics]::FromImage($large)
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $g.Clear([System.Drawing.Color]::Transparent)

        $radius = $largeSize * 0.25
        $clip = New-RoundedRectPath -X 0 -Y 0 -Width $largeSize -Height $largeSize -Radius $radius
        $g.SetClip($clip)
        $dest = New-Object System.Drawing.Rectangle(0, 0, $largeSize, $largeSize)
        $g.DrawImage($source, $dest, $crop.X, $crop.Y, $crop.Width, $crop.Height, [System.Drawing.GraphicsUnit]::Pixel)
        $g.ResetClip()

        $bmp = New-Object System.Drawing.Bitmap($size, $size)
        $small = [System.Drawing.Graphics]::FromImage($bmp)
        $small.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $small.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $small.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $small.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $small.Clear([System.Drawing.Color]::Transparent)
        $small.DrawImage($large, 0, 0, $size, $size)

        $out = Join-Path $iconDir "icon$size.png"
        $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Output "wrote $out"

        $small.Dispose()
        $bmp.Dispose()
        $clip.Dispose()
        $g.Dispose()
        $large.Dispose()
    }
}
finally {
    $source.Dispose()
}
