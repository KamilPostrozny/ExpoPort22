Pod::Spec.new do |s|
  s.name           = 'ExpoWebGuard'
  s.version        = '1.0.0'
  s.summary        = 'The terminal webview never takes the first responder'
  s.description    = 'While the key bar holds the keyboard, a WKWebView in this app cannot become first responder, so a tap in the terminal cannot take the keys down.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '17.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
